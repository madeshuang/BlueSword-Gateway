/** 麦克风采集与本机语音活动检测；不保存录音。 */
import workletUrl from './pcm-worklet.js?url';
import type {MicVAD} from '@ricky0123/vad-web';
import {PcmFrames} from './frames';
export async function prepareMicrophone(signal: AbortSignal, onChunk: (data: ArrayBuffer) => void,onActivity:(probability:number)=>void,onLimit:()=>void) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('录音需要本机 localhost 访问或 HTTPS，请改用安全地址；也可以继续打字');
  const context = new AudioContext();
  void context.resume();
  let stream: MediaStream | undefined, node: AudioWorkletNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined, gain: GainNode | undefined;
  let vad:MicVAD|undefined,recording=false,vadSetup:Promise<void>|undefined,releasePromise:Promise<void>|undefined;
  const frames=new PcmFrames(onChunk);let stopped=false,limitNotified=false;
  const release = () => {
    if (releasePromise) return releasePromise;
    stopped = true;
    recording=false;
    source?.disconnect(); node?.disconnect(); gain?.disconnect();
    stream?.getTracks().forEach(track => track.stop());
    signal.removeEventListener('abort',aborted);
    releasePromise=(async()=>{
      // 供应商尚未连接时也可能取消。等检测器初始化完成后再释放模型。
      await vadSetup?.catch(()=>{});
      await vad?.destroy().catch(()=>{});
      if (context.state !== 'closed') await context.close();
    })();
    return releasePromise;
  };
  const aborted = () => { void release(); };
  signal.addEventListener('abort',aborted,{once:true});
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio:{channelCount:1}});
    if (signal.aborted || stopped) { stream.getTracks().forEach(track=>track.stop()); throw new Error('录音已取消'); }
    await context.audioWorklet.addModule(workletUrl);
    if (signal.aborted) throw new Error('录音已取消');
    source=context.createMediaStreamSource(stream);
    node=new AudioWorkletNode(context,'pcm-capture'); gain=context.createGain();gain.gain.value=0;
    node.port.onmessage=(event: MessageEvent<ArrayBuffer>)=>{
      if (stopped) return;
      if(frames.push(new Uint8Array(event.data))&&!limitNotified){limitNotified=true;onLimit();}
    };
    let autoStopAvailable=true;
    try {
      vadSetup=(async()=>{
        // 先验证处理器可加载，避免模型已分配后才发现处理器不可用。
        await context.audioWorklet.addModule('/assets/speech-vad/vad.worklet.bundle.min.js');
        const {MicVAD}=await import('@ricky0123/vad-web');
        vad=await MicVAD.new({model:'v5',startOnLoad:false,processorType:'AudioWorklet',audioContext:context,getStream:async()=>stream!,pauseStream:async()=>{},resumeStream:async()=>stream!,baseAssetPath:'/assets/speech-vad/',onnxWASMBasePath:'/assets/speech-vad/',
          ortConfig:ort=>{ort.env.wasm.numThreads=1;ort.env.logLevel='error';},
          onFrameProcessed:probabilities=>{if(recording&&!stopped)onActivity(probabilities.isSpeech);}});
        await vad.start();await vad.pause();
      })();
      await vadSetup;
    } catch(error) {if(signal.aborted)throw error;autoStopAvailable=false;}
    if(signal.aborted||stopped)throw new Error('录音已取消');
    return {
      get autoStopAvailable(){return autoStopAvailable;},
      async start(){ if (signal.aborted || stopped) throw new Error('录音已取消');await context.resume();source!.connect(node!);node!.connect(gain!);gain!.connect(context.destination);recording=true;try{await vad?.start();}catch{autoStopAvailable=false;await vad?.destroy().catch(()=>{});vad=undefined;} },
      async stop(){ if (stopped) return;recording=false;await vad?.pause().catch(()=>{});source?.disconnect();await context.suspend();frames.flush();await release(); },
      cancel:release,
    };
  } catch(error) { signal.removeEventListener('abort',aborted);await release();throw error; }
}
