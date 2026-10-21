export type StopReason = "pause" | "no-speech" | "limit";
/** 只判定有没有讲话，不识别说话人；时间从本轮真正开始采集起计算。 */
export class SpeechEndpoint {
  private speechStart: number | undefined;
  private lastSpeech = 0;
  private heardSpeech = false;
  activity(probability: number, elapsedMs: number): void {
    if (probability >= 0.6) {
      this.speechStart ??= elapsedMs;
      if (elapsedMs-this.speechStart >= 300) this.heardSpeech = true;
      this.lastSpeech = elapsedMs;
    } else if (probability < 0.35) this.speechStart = undefined;
  }
  poll(elapsedMs: number): StopReason | null {
    if (elapsedMs >= 60000) return "limit";
    if (!this.heardSpeech) return elapsedMs >= 10000 ? "no-speech" : null;
    return elapsedMs-this.lastSpeech >= 2000 ? "pause" : null;
  }
}
