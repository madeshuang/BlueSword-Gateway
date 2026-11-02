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

  const initial = await (await page.request.get(base + '/api/tasks')).json();
  await page.goto(base);
  await page.route('**/api/speech/synthesize', route => route.fulfill({status:200,contentType:'audio/wav',body:wav}));
  await page.getByText('已连接',{exact:true}).waitFor();
  await page.getByRole('textbox').fill('矿泉水和薯片各一件');
  await page.getByRole('textbox').press('Enter');
  await page.getByRole('alertdialog').waitFor({timeout:12000}).catch(async()=>{throw new Error('Confirmation missing: '+await page.locator('body').innerText())});
  const confirmation=await page.getByRole('alertdialog').innerText();
  if (!confirmation.includes('矿泉水 × 1、薯片 × 1')) throw new Error(confirmation);
  const before=await page.request.get(base + '/api/tasks');
  if ((await before.json()).length!==initial.length) throw new Error('Moved before confirmation');
  await page.getByRole('button',{name:/^允许/}).click();
  let tasks;
  for (let attempt = 0; attempt < 100; attempt++) {
    tasks = await (await page.request.get(base + '/api/tasks')).json();
    const currentHealth = await (await page.request.get(base + '/health')).json();
    if (tasks.length === initial.length + 1 && tasks[0].status === 'completed' && !currentHealth.busy) break;
    await page.waitForTimeout(100);
  }
  if (tasks.length !== initial.length + 1 || tasks[0].status !== 'completed' || tasks[0].items.length !== 2) throw new Error('Whole order did not complete');
  await page.getByRole('button',{name:'新对话',exact:true}).click();
  await page.getByRole('heading').waitFor();
  await page.waitForTimeout(200);
  await page.getByRole('textbox').fill('两瓶矿泉水');
  await page.getByRole('textbox').press('Enter');
  await page.getByRole('alertdialog').waitFor({timeout:12000}).catch(async()=>{throw new Error('Confirmation missing: '+await page.locator('body').innerText())});
  if (!(await page.getByRole('alertdialog').innerText()).includes('矿泉水 × 2')) throw new Error('wrong count');
  await page.getByRole('button',{name:/^取消/}).click();
  await page.getByRole('alertdialog').waitFor({state:'hidden'});
  const after=await (await page.request.get(base + '/api/tasks')).json();
  if (after.length!==initial.length+1) throw new Error('Cancelled order dispatched');
  return {confirmed:tasks[0].items,status:tasks[0].status,declinedDidNotDispatch:true};
}
