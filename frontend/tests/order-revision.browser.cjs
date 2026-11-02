async page => {
  const base = new URL(page.url()).origin;
  if ((await (await page.request.get(base + '/health')).json()).mode !== 'mock') throw new Error('Use isolated mock server');
  const initial = (await (await page.request.get(base + '/api/tasks')).json()).length;
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext(); await context.resume();
      const destination = context.createMediaStreamDestination();
      window.__orderPulse = () => {
        const oscillator = context.createOscillator(); const gain = context.createGain(); gain.gain.value = .1;
        oscillator.connect(gain).connect(destination); oscillator.start(); oscillator.stop(context.currentTime + 1.2);
      };
      window.__orderPulse();
      return destination.stream;
    };
  });
  const replies = ['嗯，来一个饼干。', '嗯，再来一个薯片吧。', '再来一个薯片', '可以'];
  let recognized = 0;
  await page.route('**/api/speech', route => route.fulfill({json:{configured:true,tts:true}}));
  await page.route('**/api/speech/recognize', route => route.fulfill({json:{text:replies[recognized++] ?? ''}}));
  const wav = Buffer.alloc(44 + 3200);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(3200, 40);
  await page.route('**/api/speech/synthesize', route => route.fulfill({status:200,contentType:'audio/wav',body:wav}));
  await page.goto(base);
  await page.getByText('已连接', {exact:true}).waitFor();
  await page.getByRole('button', {name:'语音',exact:true}).click();
  await page.getByRole('alertdialog').waitFor();
  if (!(await page.getByRole('alertdialog').innerText()).includes('奥利奥 × 1')) throw new Error('Original order missing');
  await page.evaluate(() => window.__orderPulse());
  await page.getByRole('alertdialog').filter({hasText:'奥利奥 × 1、薯片 × 1'}).waitFor({timeout:12000});
  if ((await (await page.request.get(base + '/api/tasks')).json()).length !== initial) throw new Error('Dispatched edit without confirmation');
  await page.evaluate(() => window.__orderPulse());
  await page.getByText('这单最多拿两件，原来的清单先保留着。想换哪一件？',{exact:true}).waitFor();
  await page.waitForTimeout(300); // Let the controlled 100 ms reply finish before speaking.
  if (!(await page.getByRole('alertdialog').innerText()).includes('奥利奥 × 1、薯片 × 1')) throw new Error('Excess edit changed order');
  await page.evaluate(() => window.__orderPulse());
  let tasks;
  for (let i=0;i<150;i++) {
    tasks = await (await page.request.get(base + '/api/tasks')).json();
    if(tasks.length === initial+1 && tasks[0].status === 'completed') break;
    await page.waitForTimeout(100);
  }
  if(tasks.length !== initial+1 || tasks[0].status !== 'completed') throw new Error('Revised order did not complete once');
  const expected=[{item_id:'oreo',count:1},{item_id:'chips',count:1}];
  if(JSON.stringify(tasks[0].items)!==JSON.stringify(expected)) throw new Error('Executed old or excessive order');
  await page.getByRole('button',{name:'停止收音',exact:true}).click();
  return {recognized,amended:tasks[0].items,oneTask:true,noCancelNeeded:true,excessPreservedOrder:true};
}
