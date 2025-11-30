import { App, Plugin, PluginSettingTab, Setting, TFile, Notice, Modal } from 'obsidian';
import { Buffer } from 'buffer';
import { Mistral } from '@mistralai/mistralai';

/**
 * OCR 結果の pages[].images[].id と、そのBase64画像データ(imageBase64)を扱う想定。
 */
interface InlineImageMap {
  [imageId: string]: string;  // 例: { "img-0.jpeg": "data:image/jpeg;base64,..." }
}

/**
 * AI要約用のプロンプト設定
 */
interface SummaryPromptItem {
  keyComment: string;  // <!-- キー --> で使用するキー
  prompt: string;      // AIに送信するプロンプト
}

/**
 * プラグインの設定項目
 */
interface PDFToMarkdownSettings {
  // Markdownを出力するフォルダ（Vaultルートからの相対パス）空の場合はルート
  markdownOutputFolder: string;

  // 画像を保存する基準パス（Vaultルートからの相対パス）空の場合はルート
  imagesOutputFolder: string;

  // 画像フォルダ名（この名前でサブフォルダを作る）
  // デフォルトは "pdf-mistral-images"
  imagesFolderName: string;

  // Mistral API key
  mistralApiKey: string;

  // 一括処理時の最大並列実行数
  parallelProcessingLimit: number;

  // AI要約用のプロンプト設定
  summaryPrompts: SummaryPromptItem[];
}

/**
 * デフォルトのAI要約プロンプト
 */
const DEFAULT_SUMMARY_PROMPTS: SummaryPromptItem[] = [
  { keyComment: "AIに論文の要約を生成してもらう。下記の部分はAIに置き換えてもらう", prompt: "この論文を要約してください。" },
  { keyComment: "研究が行われた背景と主な目的について", prompt: "この研究が行われた背景と主な目的について詳細に教えてください。" },
  { keyComment: "研究で使用された方法論、実験設計、分析手法について", prompt: "この研究で使用された方法論、実験設計、分析手法について詳細に教えてください。" },
  { keyComment: "研究から得られた主要な結果と知見について", prompt: "この研究から得られた主要な結果と知見について詳細に教えてください。" },
  { keyComment: "著者が述べている結論と、この研究の学術的・実用的意義について", prompt: "本著者が述べている結論と、この研究の学術的・実用的意義について詳細に教えてください。" },
];

/**
 * 設定項目のデフォルト値
 */
const DEFAULT_SETTINGS: PDFToMarkdownSettings = {
  markdownOutputFolder: '',
  imagesOutputFolder: '',
  imagesFolderName: 'pdf-mistral-images',
  mistralApiKey: '',
  parallelProcessingLimit: 3,
  summaryPrompts: DEFAULT_SUMMARY_PROMPTS,
};

export default class PDFToMarkdownPlugin extends Plugin {
  settings: PDFToMarkdownSettings;

  async onload() {
    await this.loadSettings();

    // コマンド: PCからPDFを選択してMarkdownに変換
    this.addCommand({
      id: 'convert-pdf-to-markdown',
      name: 'Convert PDF to Markdown with images',
      callback: () => this.openFileDialogAndProcess()
    });

    // コマンド: Vault内のPDFを選択して処理するモーダルを開く
    this.addCommand({
        id: 'process-pdfs-from-vault-modal',
        name: 'Process PDFs from Vault (parallel process)',
        callback: () => {
            new PDFSelectionModal(this.app, this).open();
        }
    });

    // コマンド: 現在のノート名に対応するPDFを処理（Meta Bind連携用）
    this.addCommand({
      id: 'process-pdf-by-note-title',
      name: 'Process PDF matching current note title',
      callback: async () => {
        // 現在アクティブなファイルを取得
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
          new Notice('No active file found.');
          return;
        }

        // ノートのタイトル（拡張子なし）を取得
        const noteTitle = activeFile.basename;
        
        // 接頭辞「【Note】」を除いてPDFの名前を取得
        const pdfBaseName = noteTitle.replace(/^【Note】/, '');
        
        // 対応するPDFのファイル名
        const targetPdfName = `${pdfBaseName}.pdf`;
        
        // Vault内からPDFを検索
        const pdfFile = this.app.vault.getFiles().find(
          file => file.name === targetPdfName
        );

        if (!pdfFile) {
          new Notice(`PDF not found: ${targetPdfName}`);
          return;
        }

        // 出力先のフルパスを構築（接頭辞なしの名前で出力）
        const mdFolder = this.settings.markdownOutputFolder.trim();
        const targetMdName = `${pdfBaseName}.md`;
        const targetMdPath = mdFolder ? `${mdFolder}/${targetMdName}` : targetMdName;

        // 出力先パスで存在確認（ファイル名だけでなくパス全体でチェック）
        const existingFile = this.app.vault.getAbstractFileByPath(targetMdPath);

        if (existingFile) {
          new Notice(`Markdown already exists: ${targetMdPath}`);
          return;
        }

        // PDFを処理（Noticeは processPDFfromTFile 内で表示される）
        try {
          await this.processPDFfromTFile(pdfFile);
        } catch (err) {
          console.error(err);
          new Notice(`Failed to process: ${targetPdfName}`);
        }
      }
    });

    // コマンド: PDFをOCR処理した後、AI要約を生成
    this.addCommand({
      id: 'process-pdf-and-summarize',
      name: 'Process PDF and generate AI summary',
      callback: async () => {
        await this.processPdfAndSummarize();
      }
    });

    // 設定タブ
    this.addSettingTab(new PDFToMarkdownSettingTab(this.app, this));
  }

  onunload() {
    // Pluginアンロード時の処理
  }

  /**
   * PDFを選択するファイルダイアログを開き、選択した複数ファイルを順次処理
   */
  async openFileDialogAndProcess() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf';
    input.multiple = true;
    input.style.display = 'none';

    input.addEventListener('change', async () => {
      if (!input.files) return;
      const files = Array.from(input.files);
      new Notice(`Selected files: ${files.length}`);

      for (const file of files) {
        if (file.type !== 'application/pdf') {
          new Notice(`Skipping non-PDF file: ${file.name}`);
          continue;
        }
        new Notice(`Processing: ${file.name}`);
        try {
          const arrayBuffer = await file.arrayBuffer();
          const pdfBaseName = file.name.replace(/\.pdf$/i, '');
          await this.processPDFInternal(arrayBuffer, pdfBaseName, file.name);
          new Notice(`Processed: ${file.name}`);
        } catch (err) {
          console.error(`Error processing file ${file.name}:`, err);
          new Notice(`Error processing file: ${file.name}`);
        }
      }
    });
    document.body.appendChild(input);
    input.click();
    document.body.removeChild(input);
  }

  /**
   * Mistral APIを使ってPDFをOCRする共通の内部ロジック
   */
  async processPDFInternal(pdfContent: ArrayBuffer, pdfBaseName: string, originalFileName: string): Promise<void> {
    // 出力先のフルパスを構築して存在確認
    const mdFolder = this.settings.markdownOutputFolder.trim();
    const targetMdName = `${pdfBaseName}.md`;
    const targetMdPath = mdFolder ? `${mdFolder}/${targetMdName}` : targetMdName;
    
    const existingMdFile = this.app.vault.getAbstractFileByPath(targetMdPath);

    if (existingMdFile) {
      // ファイルが既に存在する場合、上書きを防ぐために処理を中断し、ユーザーに通知
      new Notice(`Error: "${targetMdPath}" already exists. Processing stopped.`, 7000);
      return;
    }

    const apiKey = this.settings.mistralApiKey.trim();
    if (!apiKey) {
      throw new Error("Mistral API key is not set in settings.");
    }
    const client = new Mistral({ apiKey });
    const fileBuffer = Buffer.from(pdfContent);
    let uploaded;
    try {
      uploaded = await client.files.upload({
        file: { fileName: originalFileName, content: fileBuffer },
        purpose: "ocr" as any
      });
    } catch (err) {
      console.error(`Error uploading file: ${originalFileName}`, err);
      throw err;
    }
    let signedUrlResponse;
    try {
      signedUrlResponse = await client.files.getSignedUrl({ fileId: uploaded.id });
    } catch (err) {
      console.error(`Error getting signed URL for file: ${originalFileName}`, err);
      throw err;
    }
    let ocrResponse;
    try {
      ocrResponse = await client.ocr.process({
        model: "mistral-ocr-latest",
        document: {
          type: "document_url",
          documentUrl: signedUrlResponse.url,
        },
        includeImageBase64: true,
      });
    } catch (err) {
      console.error(`Error during OCR process for file: ${originalFileName}`, err);
      throw err;
    }
    // mdFolder は既に上で定義済み
    if (mdFolder) {
      await this.createFolderIfNotExists(mdFolder);
    }
    const baseFolder = this.settings.imagesOutputFolder.trim();
    const folderName = this.settings.imagesFolderName.trim() || "pdf-mistral-images";
    let finalImagesPath = "";
    if (baseFolder && folderName) {
      finalImagesPath = `${baseFolder}/${folderName}`;
    } else if (baseFolder) {
      finalImagesPath = baseFolder;
    } else {
      finalImagesPath = folderName;
    }
    await this.createFolderIfNotExists(finalImagesPath);
    const finalMd = await this.combineMarkdownWithImages(ocrResponse, pdfBaseName, finalImagesPath);

    // ファイルが存在しないことが確認済みのため、設定に基づいたパスに新規作成
    const mdFilePath = mdFolder
      ? `${mdFolder}/${targetMdName}`
      : targetMdName;
    await this.app.vault.create(mdFilePath, finalMd);
  }

  /**
   * Vault内のTFileオブジェクトを処理するためのラッパー関数
   */
  async processPDFfromTFile(tfile: TFile): Promise<void> {
    new Notice(`Starting: ${tfile.name}`);
    try {
        const arrayBuffer = await this.app.vault.readBinary(tfile);
        await this.processPDFInternal(arrayBuffer, tfile.basename, tfile.name);
        new Notice(`Success: ${tfile.name}`);
    } catch(err) {
        new Notice(`Failed: ${tfile.name}. Check console for details.`);
        console.error(`Detailed error for ${tfile.name}:`, err);
        throw err;
    }
  }

  /**
   * OCRレスポンスを解析し、Base64画像をファイルに書き出し、
   * Markdownテキスト中の `![](imgId)` を Obsidian独自リンクに置換
   */
  async combineMarkdownWithImages(
    ocrResult: any,
    pdfBaseName: string,
    finalImagesPath: string
  ): Promise<string> {
    if (!ocrResult.pages || !Array.isArray(ocrResult.pages)) {
      new Notice("OCR result does not contain pages.");
      return "";
    }
    const sortedPages = ocrResult.pages.sort((a: any, b: any) => a.index - b.index);
    let combinedMarkdown = "";
    for (const page of sortedPages) {
      let md = page.markdown || "";
      for (const imgObj of page.images || []) {
        const originalId = imgObj.id;
        const base64 = imgObj.imageBase64;
        if (!base64 || base64.endsWith("...")) {
          console.warn(`Skipping empty or placeholder image: ${originalId}`);
          continue;
        }
        const trimmedId = originalId.replace(/\.(jpg|jpeg)$/i, '');
        const imageFileName = `${pdfBaseName}_${trimmedId}.jpeg`;
        const imageFilePath = `${finalImagesPath}/${imageFileName}`;
        await this.saveBase64Image(base64, imageFilePath);
        const escapedOriginalId = originalId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\!\\[[^\\]]*\\]\\((?:.*?)${escapedOriginalId}(?:.*?)\\)`, 'g');
        const obsidianLink = `![[${imageFilePath.replace(/\\/g, '/')}]]`;
        md = md.replace(regex, obsidianLink);
      }
      combinedMarkdown += md + "\n\n";
    }
    return combinedMarkdown;
  }

  /**
   * 指定フォルダが無ければ作成する
   */
  async createFolderIfNotExists(folderPath: string): Promise<void> {
    const cleanPath = folderPath.trim().replace(/^\/|\/$/g, '');
    if (cleanPath && !(await this.app.vault.adapter.exists(cleanPath))) {
      await this.app.vault.createFolder(cleanPath);
    }
  }

  /**
   * Base64文字列(形式: "data:image/jpeg;base64,...")をバイナリに変換し、Vault内に書き込む
   */
  async saveBase64Image(base64: string, filePath: string): Promise<void> {
    const matches = base64.match(/^data:image\/jpeg;base64,(.+)/);
    if (!matches || matches.length < 2) {
      console.error("Invalid Base64 image format (prefix missing or wrong type):", base64.substring(0, 50));
      return;
    }
    const buffer = Buffer.from(matches[1], "base64");
    // BufferをArrayBufferに変換
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    await this.app.vault.adapter.writeBinary(filePath, arrayBuffer);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /**
   * PDFをOCR処理した後、AI要約を生成してノートを更新する
   */
  async processPdfAndSummarize(): Promise<void> {
    // 現在アクティブなファイル（要約先ノート）を取得
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice('アクティブなファイルがありません');
      return;
    }

    // ノートのタイトル（拡張子なし）を取得
    const noteTitle = activeFile.basename;
    
    // 接頭辞「【Note】」を除いてPDF/要約元の名前を取得
    const srcBaseName = noteTitle.replace(/^【Note】/, '');
    
    if (srcBaseName === noteTitle) {
      new Notice('【Note】プレフィックスがありません: ' + noteTitle);
      return;
    }

    // 対応するPDFのファイル名
    const targetPdfName = `${srcBaseName}.pdf`;
    
    // Vault内からPDFを検索
    const pdfFile = this.app.vault.getFiles().find(
      file => file.name === targetPdfName
    );

    // 出力先のフルパスを構築
    const mdFolder = this.settings.markdownOutputFolder.trim();
    const targetMdName = `${srcBaseName}.md`;
    const targetMdPath = mdFolder ? `${mdFolder}/${targetMdName}` : targetMdName;

    // OCR済みMarkdownが存在するかチェック
    let srcFile = this.app.vault.getAbstractFileByPath(targetMdPath) as TFile | null;

    // Markdownが存在しない場合、PDFをOCR処理
    if (!srcFile) {
      if (!pdfFile) {
        new Notice(`PDF not found: ${targetPdfName}`);
        return;
      }

      new Notice(`OCR処理を開始: ${targetPdfName}`);
      try {
        await this.processPDFfromTFile(pdfFile);
      } catch (err) {
        console.error(err);
        new Notice(`Failed to process: ${targetPdfName}`);
        return;
      }

      // 処理後にファイルを再取得
      srcFile = this.app.vault.getAbstractFileByPath(targetMdPath) as TFile | null;
      if (!srcFile) {
        new Notice('OCR処理後もMarkdownファイルが見つかりません');
        return;
      }
    }

    // 要約元の内容を読み取る
    const srcContent = await this.app.vault.read(srcFile);

    // 要約先ノート（現在のノート）の内容を読み取る
    let noteContent = await this.app.vault.read(activeFile);

    // <!-- キー --> を全て抽出
    const commentRegex = /<!--\s*([\s\S]*?)\s*-->/g;
    const allMatches = [...noteContent.matchAll(commentRegex)];

    // ノート内のコメントからキーのセットを作成
    const keysInNote = new Set(allMatches.map(match => match[1].trim()));

    // 設定からプロンプトマップを作成
    const promptMap: { [key: string]: string } = {};
    for (const item of this.settings.summaryPrompts) {
      promptMap[item.keyComment] = item.prompt;
    }

    // プロンプト設定の各キーがノート内に存在するかチェック
    const keysToProcess = Object.keys(promptMap).filter(key => keysInNote.has(key));

    if (keysToProcess.length === 0) {
      const availableKeys = Object.keys(promptMap).join(', ');
      new Notice(`有効なキーが見つかりません。使用可能: ${availableKeys}`);
      return;
    }

    // 対応するmatchオブジェクトを取得（置換用）
    const validMatches: { fullMatch: string; key: string }[] = [];
    for (const key of keysToProcess) {
      const match = allMatches.find(m => m[1].trim() === key);
      if (match) {
        validMatches.push({ fullMatch: match[0], key: match[1].trim() });
      }
    }

    // Text Generator プラグインを取得
    const tg = (this.app as any).plugins.getPlugin('obsidian-textgenerator-plugin');
    if (!tg) {
      new Notice('Text Generator プラグインが見つかりません');
      return;
    }

    new Notice(`AI要約を開始: ${validMatches.length}件のキーを処理`);

    // 各キーを処理
    for (const matchInfo of validMatches) {
      const fullComment = matchInfo.fullMatch;       // <!-- キー --> 全体
      const key = matchInfo.key;                     // キー名
      const userInstruction = promptMap[key];        // 対応するプロンプト

      // プロンプト作成（定義済みプロンプト + 要約元の内容）
      const promptText = `${userInstruction}\n\n---\n\n${srcContent}`;

      // AI 要約を生成
      let result;
      try {
        result = await tg.pluginAPIService.gen(promptText);
      } catch (e: any) {
        new Notice('APIエラー: ' + (e.message || e));
        return;
      }

      // 結果を取得
      const summaryText = result?.text ?? result?.content ?? result ?? '';

      // コメント部分を要約で置き換え
      noteContent = noteContent.replace(fullComment, summaryText);
    }

    // 全ての置換が終わったらファイルを保存
    await this.app.vault.modify(activeFile, noteContent);
    new Notice(`要約が完了しました！（${validMatches.length}件処理）`);
  }
}

/**
 * PDF選択と並列処理のためのモーダル
 */
class PDFSelectionModal extends Modal {
    plugin: PDFToMarkdownPlugin;

    constructor(app: App, plugin: PDFToMarkdownPlugin) {
        super(app);
        // --- ★★★ バグ修正: この行を追加 ★★★ ---
        this.plugin = plugin;
    }

    async onOpen() {
        const { contentEl, modalEl } = this;
        contentEl.empty();
        
        modalEl.style.width = 'min(90vw, 900px)';

        contentEl.createEl('h2', { text: 'Process PDFs in Vault' });
        contentEl.createEl('p', { text: `Select PDFs to process. Files will be processed in parallel. (Max concurrent tasks: ${this.plugin.settings.parallelProcessingLimit})` });

        const pdfFiles = this.app.vault.getFiles().filter(file => file.extension === 'pdf');
        if (pdfFiles.length === 0) {
            contentEl.createEl('p', { text: 'No PDF files found in your vault.' });
            return;
        }

        // Vault内の全Markdownファイル名一覧を先に取得し、高速で検索できるようにSetに格納
        const allMarkdownFileNames = new Set(this.app.vault.getMarkdownFiles().map(f => f.name));

        const tableContainer = contentEl.createDiv({ cls: 'pdf-list-container' });
        tableContainer.style.maxHeight = '50vh';
        tableContainer.style.overflowY = 'auto';
        tableContainer.style.border = '1px solid var(--background-modifier-border)';
        tableContainer.style.marginBottom = '1em';

        const table = tableContainer.createEl('table');
        table.style.width = '100%';
        const thead = table.createEl('thead');
        const headerRow = thead.createEl('tr');
        headerRow.createEl('th', { text: 'Select' });
        headerRow.createEl('th', { text: 'PDF File' });
        headerRow.createEl('th', { text: 'Status' });
        const tbody = table.createEl('tbody');
        const fileProcessingList: { pdfFile: TFile, checkbox: HTMLInputElement }[] = [];

        for (const pdfFile of pdfFiles) {
            // パスを構築するのではなく、ファイル名だけで存在をチェック
            const targetMdName = `${pdfFile.basename}.md`;
            const mdFileExists = allMarkdownFileNames.has(targetMdName);

            const row = tbody.createEl('tr');
            const selectCell = row.createEl('td');
            if (mdFileExists) {
                selectCell.setText('生成済み');
            } else {
                const checkbox = selectCell.createEl('input', { type: 'checkbox' });
                checkbox.dataset.pdfPath = pdfFile.path;
                fileProcessingList.push({ pdfFile, checkbox });
            }
            row.createEl('td', { text: pdfFile.path });
            row.createEl('td', { text: mdFileExists ? '✔' : '未生成' });
        }

        const buttonContainer = contentEl.createDiv();
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'space-between';
        
        const selectionButtons = buttonContainer.createDiv();
        const actionButtons = buttonContainer.createDiv();

        const selectAllButton = selectionButtons.createEl('button', { text: 'Select All' });
        selectAllButton.style.marginRight = '10px';
        const deselectAllButton = selectionButtons.createEl('button', { text: 'Deselect All' });
        
        const processButton = actionButtons.createEl('button', { text: 'Process Selected PDFs', cls: 'mod-cta' });
        processButton.style.marginRight = '10px';
        const closeButton = actionButtons.createEl('button', { text: 'Close' });

        selectAllButton.addEventListener('click', () => {
            fileProcessingList.forEach(item => item.checkbox.checked = true);
        });
        deselectAllButton.addEventListener('click', () => {
            fileProcessingList.forEach(item => item.checkbox.checked = false);
        });
        closeButton.addEventListener('click', () => this.close());
        
        processButton.addEventListener('click', async () => {
            const selectedFiles = fileProcessingList
                .filter(item => item.checkbox.checked)
                .map(item => item.pdfFile);
            if (selectedFiles.length === 0) {
                new Notice('No new PDFs selected.');
                return;
            }

            processButton.disabled = true;
            selectAllButton.disabled = true;
            deselectAllButton.disabled = true;
            closeButton.disabled = true;
            processButton.setText('Processing...');
            
            const concurrencyLimit = this.plugin.settings.parallelProcessingLimit;
            const queue = [...selectedFiles];
            let successCount = 0;
            let failureCount = 0;

            new Notice(`Starting processing of ${queue.length} files with ${concurrencyLimit} parallel workers.`);

            const worker = async () => {
                while (queue.length > 0) {
                    const fileToProcess = queue.shift();
                    if (!fileToProcess) continue;

                    try {
                        await this.plugin.processPDFfromTFile(fileToProcess);
                        successCount++;
                    } catch (e) {
                        failureCount++;
                    }
                }
            };

            const workerPromises = [];
            for (let i = 0; i < concurrencyLimit; i++) {
                workerPromises.push(worker());
            }

            await Promise.all(workerPromises);

            new Notice(`Processing complete. Success: ${successCount}, Failed: ${failureCount}.`);
            this.close();
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}


/**
 * 設定タブ (プラグインオプション)
 */
class PDFToMarkdownSettingTab extends PluginSettingTab {
  plugin: PDFToMarkdownPlugin;

  constructor(app: App, plugin: PDFToMarkdownPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'PDF to Markdown (Inline Image) Settings' });

    new Setting(containerEl)
      .setName('Markdown Output Folder')
      .setDesc('Folder to save the generated Markdown (relative to vault root). Empty = root')
      .addText(text => {
        text
          .setPlaceholder('e.g. PDFOut')
          .setValue(this.plugin.settings.markdownOutputFolder)
          .onChange(async (value) => {
            this.plugin.settings.markdownOutputFolder = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Images Output Folder')
      .setDesc('Base folder path for images (relative to vault root). Empty = root')
      .addText(text => {
        text
          .setPlaceholder('e.g. MyImagesFolder')
          .setValue(this.plugin.settings.imagesOutputFolder)
          .onChange(async (value) => {
            this.plugin.settings.imagesOutputFolder = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Images Folder Name')
      .setDesc('The subfolder name for images. Default is "pdf-mistral-images"')
      .addText(text => {
        text
          .setPlaceholder('pdf-mistral-images')
          .setValue(this.plugin.settings.imagesFolderName)
          .onChange(async (value) => {
            this.plugin.settings.imagesFolderName = value.trim() || 'pdf-mistral-images';
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Mistral API Key')
      .setDesc('Your Mistral API key. Keep it private!')
      .addText(text => {
        text
          .setPlaceholder('Enter your Mistral API key here')
          .setValue(this.plugin.settings.mistralApiKey)
          .onChange(async (value) => {
            this.plugin.settings.mistralApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });
      
    new Setting(containerEl)
        .setName('Parallel Processing Limit')
        .setDesc('Number of files to process concurrently. Lower this if you encounter API rate limits.')
        .addText(text => {
            text
                .setPlaceholder('e.g., 3')
                .setValue(String(this.plugin.settings.parallelProcessingLimit))
                .onChange(async (value) => {
                    const num = parseInt(value, 10);
                    if (!isNaN(num) && num > 0) {
                        this.plugin.settings.parallelProcessingLimit = num;
                        await this.plugin.saveSettings();
                    }
                });
        });

    // AI要約プロンプト設定セクション
    containerEl.createEl('h3', { text: 'AI Summary Prompts' });
    containerEl.createEl('p', { 
      text: 'ノート内の <!-- Key Comment --> をAIで置き換える際のプロンプトを設定します。',
      cls: 'setting-item-description'
    });

    // プロンプト一覧を表示するコンテナ
    const promptsContainer = containerEl.createDiv({ cls: 'summary-prompts-container' });
    
    this.renderPromptsList(promptsContainer);

    // 新規プロンプト追加ボタン
    new Setting(containerEl)
      .setName('Add New Prompt')
      .setDesc('新しいKey CommentとPromptのペアを追加します')
      .addButton(button => {
        button
          .setButtonText('+ Add Prompt')
          .setCta()
          .onClick(async () => {
            this.plugin.settings.summaryPrompts.push({
              keyComment: '',
              prompt: ''
            });
            await this.plugin.saveSettings();
            this.renderPromptsList(promptsContainer);
          });
      });

    // デフォルトにリセットボタン
    new Setting(containerEl)
      .setName('Reset to Defaults')
      .setDesc('プロンプト設定をデフォルトに戻します')
      .addButton(button => {
        button
          .setButtonText('Reset')
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.summaryPrompts = [...DEFAULT_SUMMARY_PROMPTS];
            await this.plugin.saveSettings();
            this.renderPromptsList(promptsContainer);
            new Notice('プロンプト設定をデフォルトにリセットしました');
          });
      });
  }

  /**
   * プロンプト一覧をレンダリング
   */
  renderPromptsList(container: HTMLElement): void {
    container.empty();

    if (this.plugin.settings.summaryPrompts.length === 0) {
      container.createEl('p', { 
        text: 'プロンプトが設定されていません。「Add Prompt」で追加してください。',
        cls: 'setting-item-description'
      });
      return;
    }

    this.plugin.settings.summaryPrompts.forEach((promptItem, index) => {
      const itemContainer = container.createDiv({ cls: 'summary-prompt-item' });
      itemContainer.style.marginBottom = '1.5em';
      itemContainer.style.padding = '1em';
      itemContainer.style.border = '1px solid var(--background-modifier-border)';
      itemContainer.style.borderRadius = '8px';

      // ヘッダー（番号と削除ボタン）
      const headerDiv = itemContainer.createDiv();
      headerDiv.style.display = 'flex';
      headerDiv.style.justifyContent = 'space-between';
      headerDiv.style.alignItems = 'center';
      headerDiv.style.marginBottom = '0.5em';

      headerDiv.createEl('strong', { text: `Prompt #${index + 1}` });

      const deleteBtn = headerDiv.createEl('button', { text: 'Delete' });
      deleteBtn.style.color = 'var(--text-error)';
      deleteBtn.addEventListener('click', async () => {
        this.plugin.settings.summaryPrompts.splice(index, 1);
        await this.plugin.saveSettings();
        this.renderPromptsList(container);
      });

      // Key Comment入力
      const keyCommentSetting = new Setting(itemContainer)
        .setName('Key Comment')
        .setDesc('ノート内で使用するコメントキー（例: 研究が行われた背景と主な目的について）');
      
      const keyCommentInput = keyCommentSetting.controlEl.createEl('textarea');
      keyCommentInput.value = promptItem.keyComment;
      keyCommentInput.placeholder = '例: 研究が行われた背景と主な目的について';
      keyCommentInput.style.width = '100%';
      keyCommentInput.style.minHeight = '60px';
      keyCommentInput.style.resize = 'vertical';
      keyCommentInput.addEventListener('change', async () => {
        this.plugin.settings.summaryPrompts[index].keyComment = keyCommentInput.value;
        await this.plugin.saveSettings();
      });

      // Prompt入力
      const promptSetting = new Setting(itemContainer)
        .setName('Prompt')
        .setDesc('AIに送信するプロンプト文');
      
      const promptInput = promptSetting.controlEl.createEl('textarea');
      promptInput.value = promptItem.prompt;
      promptInput.placeholder = '例: この研究が行われた背景と主な目的について詳細に教えてください。';
      promptInput.style.width = '100%';
      promptInput.style.minHeight = '80px';
      promptInput.style.resize = 'vertical';
      promptInput.addEventListener('change', async () => {
        this.plugin.settings.summaryPrompts[index].prompt = promptInput.value;
        await this.plugin.saveSettings();
      });
    });
  }
}