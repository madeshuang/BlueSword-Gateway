async page => {
  const base = new URL(page.url()).origin;
  if ((await (await page.request.get(base + '/health')).json()).mode !== 'mock') throw new Error('Use isolated mock server');
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext(); await context.resume();
      const destination = context.createMediaStreamDestination();
      window.__homePulse = () => {
        const oscillator = context.createOscillator();
        const gain = context.createGain(); gain.gain.value = .1;
        oscillator.connect(gain).connect(destination);
        oscillator.start(); oscillator.stop(context.currentTime + 1.2);
      };
      window.__homePulse();
      return destination.stream;
    };
  });
  let mode = 'error';
  let requests = 0;
  await page.route('**/api/speech', route => route.fulfill({json:{configured:true,tts:true}}));
  await page.route('**/api/speech/recognize', route => {
    requests++;
    return mode === 'error'
      ? route.fulfill({status:502,json:{detail:'这次没听清，稍后再试试。'}})
      : route.fulfill({json:{text:mode === 'wake' ? '你好，布鲁。' : '查询库存'}});
  });
  await page.route('**/api/speech/synthesize', route => route.fulfill({status:503,json:{detail:'controlled silence'}}));
  const failures = [];
  for (const current of ['error', 'wake', 'command']) {
    mode = current;
    await page.goto(base);
    await page.getByText('已连接', {exact:true}).waitFor();
    if (!await page.getByPlaceholder('说「你好，布鲁」唤醒我，或在这里输入…').count()) throw new Error('首页缺少唤醒词');
    const before = requests;
    await page.getByRole('button', {name:'语音',exact:true}).click();
    for(let i=0;i<100 && requests===before;i++) await page.waitForTimeout(100);
    if(requests===before) throw new Error('No homepage recording uploaded');
    await page.waitForTimeout(500);
    if(current === 'error') {
      await page.getByText('语音刚才没接上，点麦克风再试一下吧。', {exact:true}).waitFor({state:'visible',timeout:4000}).catch(() => failures.push('首页识别失败提示不可见'));
    } else if(current === 'wake') {
      if(await page.locator('.view-session').count() !== 1) failures.push('首页识别到唤醒词后没有进入聆听对话');
      mode = 'command';
      await page.evaluate(() => window.__homePulse());
      await page.locator('.msg.user .bubble').filter({hasText:'查询库存'}).waitFor({timeout:8000});
    } else {
      if(await page.locator('.view-session').count() !== 1) failures.push('首页普通语音未提交');
    }
  }
  if(failures.length) throw new Error(failures.join('；'));
  return {homeErrorVisible:true,wakeEntersConversation:true,homeCommandSubmitted:true,asrRequests:requests};
}
