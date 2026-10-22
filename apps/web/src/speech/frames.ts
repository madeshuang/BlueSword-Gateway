/** 16kHz、16bit单声道PCM：按200毫秒发送，最多60秒。 */
export class PcmFrames {
  private pending=new Uint8Array(0);
  private bytes=0;
  constructor(private send:(data:ArrayBuffer)=>void){}
  push(data:Uint8Array):boolean {
    const accepted=data.subarray(0,Math.max(0,1920000-this.bytes));this.bytes+=accepted.length;
    const merged=new Uint8Array(this.pending.length+accepted.length);merged.set(this.pending);merged.set(accepted,this.pending.length);this.pending=merged;
    while(this.pending.length>=6400){this.send(this.pending.slice(0,6400).buffer);this.pending=this.pending.slice(6400);}
    return this.bytes>=1920000;
  }
  flush():void {if(this.pending.length)this.send(this.pending.slice().buffer);this.pending=new Uint8Array(0);}
}
