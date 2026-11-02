async root => {
  const testContext = await root.context().browser().newContext();
  const base=new URL(root.url()).origin;
  const page=await testContext.newPage();
  const check=(ok,msg)=>{if(!ok)throw Error(msg)};
  const wav=Buffer.alloc(44+16000*4*2);
  wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
  for(let i=0;i<64000;i++)wav.writeInt16LE(Math.round(Math.sin(i*.1)*500),44+i*2);
  let asrCount=0,pending,mode='normal',step='startup';
  try {
    check((await(await page.request.get(base+'/health')).json()).mode==='mock','Isolated mock server required');
    await page.addInitScript(()=>{
      navigator.mediaDevices.getUserMedia=async()=>{
        const c=window.__inputContext??=new AudioContext();await c.resume();const dest=c.createMediaStreamDestination();window.__micStream=dest.stream;
        window.__pulse=duration=>{const osc=c.createOscillator(),gain=c.createGain();gain.gain.value=.1;osc.connect(gain).connect(dest);osc.start();osc.stop(c.currentTime+duration)};
        return dest.stream;
      };
      const start=AudioBufferSourceNode.prototype.start,stop=AudioBufferSourceNode.prototype.stop;
      AudioBufferSourceNode.prototype.start=function(...args){window.__starts=(window.__starts||0)+1;window.__outputPlaying=true;this.addEventListener('ended',()=>window.__outputPlaying=false);return start.apply(this,args)};
      AudioBufferSourceNode.prototype.stop=function(...args){window.__stops=(window.__stops||0)+1;return stop.apply(this,args)};
    });
    await page.route('**/api/speech',r=>r.fulfill({json:{configured:true,tts:true}}));
    await page.route('**/api/speech/synthesize',r=>r.fulfill({status:200,contentType:'audio/wav',body:wav}));
    await page.route('**/api/speech/recognize',async r=>{
      asrCount++;
      if(mode==='held'){pending=r;return}
      await r.fulfill({json:{text:asrCount===1?'你是谁':'介绍一下兰剑智能'}});
    });
    await page.goto(base);await page.evaluate(()=>localStorage.clear());await page.reload();await page.getByText('已连接',{exact:true}).waitFor();
    await page.waitForFunction(() => document.querySelector('.mic[aria-pressed="true"]') || ['点一下麦克风，就能和我说话啦', '说「你好，布鲁」叫我，或在这里输入…'].includes(document.querySelector('input')?.placeholder));
    if(await page.getByRole('button',{name:'语音',exact:true}).count()) { await page.getByRole('button',{name:'语音',exact:true}).click(); }
    await page.getByRole('button',{name:'停止收音',exact:true}).waitFor();
    step='first pulse'; await page.evaluate(()=>window.__pulse(.35));await page.waitForTimeout(420);
    await page.getByRole('button',{name:'停止收音',exact:true}).click();
    await page.locator('.msg.user .bubble').filter({hasText:'你是谁'}).last().waitFor();
    check(asrCount===1,'Stop lost or duplicated final utterance');
    check(await page.evaluate(()=>window.__micStream.getTracks().every(t=>t.readyState==='ended')),'Mic not released');
    await page.waitForFunction(()=>window.__outputPlaying===true);
    step='restart for barge in'; await page.getByRole('button',{name:'语音',exact:true}).click();
    await page.getByRole('button',{name:'停止收音',exact:true}).waitFor();
    const stops=await page.evaluate(()=>window.__stops||0);
    check(await page.evaluate(()=>window.__outputPlaying),'Output stopped when input reopened');
    step='barge pulse'; await page.evaluate(()=>window.__pulse(.4));
    await page.locator('.msg.user .bubble').filter({hasText:'介绍一下兰剑智能'}).last().waitFor({timeout:8000});
    check(asrCount===2,'Barge-in not captured once');
    check(await page.evaluate(()=>window.__stops)>stops,'Barge-in did not interrupt output');
    await page.waitForFunction(()=>window.__starts>=2&&window.__outputPlaying);
    step='stop during second playback'; const beforeStop=await page.evaluate(()=>window.__stops||0);
    await page.getByRole('button',{name:'停止收音',exact:true}).click();
    check(await page.evaluate(()=>window.__stops||0)===beforeStop,'Stopping input stopped playback');
    check(await page.evaluate(()=>window.__outputPlaying),'Playback did not continue');
    step='third recording'; await page.getByRole('button',{name:'语音',exact:true}).click();mode='held';
    await page.getByRole('button',{name:'停止收音',exact:true}).waitFor();
    await page.evaluate(()=>window.__pulse(.3));
    for(let i=0;i<60&&!pending;i++)await page.waitForTimeout(100);
    check(!!pending,'No pending recognition');
    await page.getByRole('button',{name:'停止收音',exact:true}).click();
    await pending.fulfill({json:{text:'查询库存'}});pending=null;
    await page.locator('.msg.user .bubble').filter({hasText:'查询库存'}).last().waitFor();
    check(asrCount===3,'Pending recognition duplicated');
    return {stoppedUtteranceSubmitted:true,micReleased:true,bargeIn:true,outputIndependent:true,pendingAsrPreserved:true,asrCount};
  } catch(e) { throw Error(step+': '+e.message+' UI: '+await page.locator('body').innerText()+' placeholder: '+await page.getByRole('textbox').getAttribute('placeholder')); } finally {if(pending)await pending.fulfill({json:{text:''}}).catch(()=>{});await testContext.close();}
}
