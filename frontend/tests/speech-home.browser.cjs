async root => {
  const testContext = await root.context().browser().newContext();
  const page = await testContext.newPage();
  const base = new URL(root.url()).origin;
  const check = (ok, message) => { if (!ok) throw Error(message); };
  let transcript = '', fail = false, requests = 0;
  try {
    check((await (await page.request.get(base + '/health')).json()).mode === 'mock', 'Use isolated mock server');
    await page.addInitScript(() => {
      localStorage.clear();
      navigator.mediaDevices.getUserMedia = async () => {
        const context = new AudioContext(); await context.resume();
        const destination = context.createMediaStreamDestination();
        window.__homePulse = () => {
          const oscillator = context.createOscillator(), gain = context.createGain(); gain.gain.value = .1;
          oscillator.connect(gain).connect(destination); oscillator.start(); oscillator.stop(context.currentTime + .35);
        };
        return destination.stream;
      };
    });
    await page.route('**/api/speech', r => r.fulfill({json:{configured:true,tts:true}}));
    await page.route('**/api/speech/recognize', r => {
      requests++;
      return fail ? r.fulfill({status:502,json:{detail:'controlled failure'}}) : r.fulfill({json:{text:transcript}});
    });
    await page.route('**/api/speech/synthesize', r => r.fulfill({status:503,json:{detail:'controlled silence'}}));
    const start = async () => {
      await page.goto(base); await page.getByText('已连接', {exact:true}).waitFor();
      await page.waitForFunction(() => ['点一下麦克风，就能和我说话啦', '说「你好，布鲁」叫我，或在这里输入…'].includes(document.querySelector('input')?.placeholder));
      // Satisfy browser audio policy without using the direct-conversation mic button.
      await page.locator('.home-title').click();
      await page.getByPlaceholder('说「你好，布鲁」叫我，或在这里输入…').waitFor();
    };
    const say = async text => {
      transcript = text; const before = requests;
      await page.evaluate(() => window.__homePulse());
      for (let i=0;i<80 && requests===before;i++) await page.waitForTimeout(100);
      check(requests===before+1, 'Recording was lost or duplicated');
      await page.waitForTimeout(300);
    };
    await start();
    await say('今天吃点什么');
    check(await page.locator('.view-home').count()===1, 'Standby chatter entered conversation');
    check(await page.locator('.msg.user').count()===0, 'Standby chatter was submitted');
    await say('布噜');
    await page.locator('.view-session').waitFor();
    await page.getByRole('button',{name:'停止收音',exact:true}).waitFor();
    await say('查询库存');
    await page.locator('.msg.user .bubble').filter({hasText:'查询库存'}).waitFor();
    await start();
    await say('你好，布卢，查询库存');
    await page.locator('.msg.user .bubble').filter({hasText:'查询库存'}).waitFor();
    check(await page.locator('.msg.user .bubble').innerText()==='查询库存','Wake prefix leaked into request');
    await start();
    const initialBox = await page.locator('.composer').boundingBox();
    await page.getByRole('button',{name:'语音',exact:true}).click();
    await page.getByRole('button',{name:'停止收音',exact:true}).waitFor();
    check(await page.locator('.view-home').count()===1,'Microphone click prematurely left home');
    check(Math.abs((await page.locator('.composer').boundingBox()).y-initialBox.y)<2,'Microphone click moved the home input');
    await say('查询库存');
    await page.locator('.msg.user .bubble').filter({hasText:'查询库存'}).waitFor();
    await page.getByRole('button',{name:'新对话',exact:true}).click();
    await page.locator('.view-home').waitFor();
    const newBox = await page.locator('.composer').boundingBox();
    await page.getByRole('button',{name:'语音',exact:true}).click();
    await page.getByRole('button',{name:'停止收音',exact:true}).waitFor();
    check(await page.locator('.view-home').count()===1,'Microphone click left home after new conversation');
    check(Math.abs((await page.locator('.composer').boundingBox()).y-newBox.y)<2,'Microphone click moved the new-conversation input');
    await say('布鲁');
    await page.locator('.view-session').waitFor();
    fail=true; await say('controlled failure');
    await page.getByText('这句话暂时没听清，可以再说一次或打字。',{exact:true}).waitFor();
    return {standbyIgnoresChat:true,aliasWakes:true,followingRequestPreserved:true,chainedWakeRequest:true,manualFallback:true,clickKeepsHomePosition:true,newConversationClickKeepsHomePosition:true,errorVisible:true,asrRequests:requests};
  } catch(e) { throw Error(e.message+' UI: '+await page.locator('body').innerText()); }
  finally { await testContext.close(); }
}
