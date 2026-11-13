import * as vscode from 'vscode';

export class SelectionCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[];

  public readonly onDidChangeCodeLenses = this.changeEmitter.event;

  public constructor() {
    this.disposables = [
      this.changeEmitter,
      vscode.window.onDidChangeTextEditorSelection(() => this.changeEmitter.fire()),
      vscode.window.onDidChangeActiveTextEditor(() => this.changeEmitter.fire())
    ];
  }

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const editor = vscode.window.activeTextEditor;
    if (
      !editor ||
      editor.document.uri.toString() !== document.uri.toString() ||
      editor.selection.isEmpty ||
      document.uri.scheme !== 'file'
    ) {
      return [];
    }

    const line = editor.selection.start.line;
    const range = new vscode.Range(line, 0, line, 0);
    return [
      new vscode.CodeLens(range, {
        command: 'codeChasing.analyzeSelection',
        title: '$(comment-discussion) CodeChasing：询问或追踪这段代码',
        tooltip: '针对选中代码自由提问，或追踪贯穿示例与张量形状'
      })
    ];
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
