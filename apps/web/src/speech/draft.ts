/** 录音结果只进入可编辑草稿；该模块没有发送聊天或任务的能力。 */
export class SpeechDraft {
  value = '';
  private revision = 0;
  private nextRun = 0;
  private active: { id: number; revision: number } | undefined;

  edit(value: string): void {
    this.value = value;
    this.revision++;
  }

  begin(): number {
    const id = ++this.nextRun;
    this.active = { id, revision: this.revision };
    return id;
  }

  complete(id: number, text: string): boolean {
    if (!this.active || this.active.id !== id) return false;
    const untouched = this.active.revision === this.revision;
    this.active = undefined;
    if (!untouched || !text.trim()) return false;
    const next = this.value ? `${this.value}\n${text}` : text;
    if (next.length > 2000) return false;
    this.edit(next);
    return true;
  }

  cancel(): void { this.active = undefined; }
}
