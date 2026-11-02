async page => {
  const base = new URL(page.url()).origin;
  const health = await (await page.request.get(base + '/health')).json();
  if (health.mode !== 'mock') throw new Error('Only run this check against an isolated mock server');
  const samples = 16000;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i * 0.1) * 1000), 44 + i * 2);

  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext(); await context.resume();
      const destination = context.createMediaStreamDestination();
      window.__pulse = () => {
        const oscillator = context.createOscillator(); const gain = context.createGain(); gain.gain.value=.1;
        oscillator.connect(gain).connect(destination); oscillator.start(); oscillator.stop(context.currentTime+1.2);
      };
      window.__pulse();
      window.__testMicStream = destination.stream;
      return destination.stream;
    };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function(...args) { window.__played = (window.__played||0)+1; return start.apply(this,args); };
  });
  await page.goto(base);
  await page.route('**/api/speech', route => route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({configured:true,tts:true})}));
  let recognized=0, bytes=0, pending;
  let notifyThird; const thirdStarted=new Promise(resolve=>notifyThird=resolve);
  let notify; const secondStarted=new Promise(resolve=>notify=resolve);
  await page.route('**/api/speech/recognize', async route => {
    recognized++; if(recognized===3) notifyThird(); bytes=route.request().postDataBuffer().length;
    if (recognized===2) { pending=route; notify(); return; }
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({text:recognized===3 ? '拿两瓶矿泉水' : '你好，布鲁，拿两瓶矿泉水。'})});
  });
  await page.route('**/api/speech/synthesize', route => route.fulfill({status:200,contentType:'audio/wav',body:wav}));
  await page.getByText('已连接',{exact:true}).waitFor();
  await page.getByRole('button',{name:'语音',exact:true}).click();
  await page.getByRole('alertdialog').waitFor();
  if (!(await page.getByRole('alertdialog').innerText()).includes('矿泉水 × 2')) throw new Error('voice order wrong');
  if (bytes<6400) throw new Error('no captured PCM');
  await page.getByRole('button',{name:/^取消/}).click();
  await page.waitForFunction(()=>window.__played>0);
  await page.getByRole('button',{name:'停止收音',exact:true}).click();
  const stopped=await page.evaluate(()=>window.__testMicStream.getTracks().every(t=>t.readyState==='ended'));
  if (!stopped) throw new Error('microphone not released');
  await page.getByRole('button',{name:'开启语音',exact:true}).click();
  await secondStarted;
  await page.getByRole('button',{name:'新对话',exact:true}).click();
  await page.getByRole('heading').waitFor();
  await pending.fulfill({status:200,contentType:'application/json',body:JSON.stringify({text:'拿两瓶水'})}).catch(()=>{});
  await page.waitForTimeout(500);
  if (await page.getByRole('alertdialog').count()) throw new Error('stale recognition submitted after reset');
  await page.evaluate(()=>window.__pulse());
  await thirdStarted; await page.waitForTimeout(500);
  if (await page.getByRole('alertdialog').count()) throw new Error('standby accepted text without wake phrase');
  await page.evaluate(()=>window.__pulse());
  await page.getByRole('alertdialog').waitFor();
  await page.getByRole('button',{name:/^取消/}).click();
  await page.getByRole('button',{name:'停止收音',exact:true}).click();
  return {capturedPcmBytes:bytes,voiceConfirmation:true,ttsPlayed:true,micReleased:stopped,staleAsrDiscarded:true,standbyIgnoresSpeech:true,wakeReactivates:true};
}
