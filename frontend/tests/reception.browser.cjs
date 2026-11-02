async root => {
  const testContext = await root.context().browser().newContext();
  const page = await testContext.newPage();
  const base = new URL(root.url()).origin;
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const staff = {'X-Operator-Token':'acceptance-only'};
  try {
    check((await (await page.request.get(base+'/health')).json()).mode === 'mock', 'Isolated mock server required');
  const restored = await page.request.post(base + '/api/inventory/reset', {headers:{'X-Operator-Token':'acceptance-only'}});
  if (!restored.ok()) throw Error('Isolated test stock could not be restored');
    await page.route('**/api/speech', r=>r.fulfill({json:{configured:false}}));
    await page.goto(base); await page.evaluate(()=>localStorage.clear()); await page.reload();
    await page.getByText('已连接',{exact:true}).waitFor();
    check(await page.getByText('先点麦克风开启语音，就能叫我啦').count()===0,'Old hint remains');
    check(await page.getByRole('button',{name:'播报开',exact:true}).count()===0,'Old TTS button remains');
    const send = async text => { await page.getByRole('textbox').fill(text); await page.getByRole('textbox').press('Enter'); };
    await send('拿一包奥利奥');
    await page.getByRole('alertdialog').filter({hasText:'奥利奥饼干 × 1'}).waitFor();
    check(/1[6-8]\ds/.test(await page.getByRole('alertdialog').innerText()), 'Confirmation not 180 seconds');
    await send('再拿一包薯片');
    await page.getByRole('alertdialog').filter({hasText:'奥利奥饼干 × 1、乐事薯片 × 1'}).waitFor();
    await page.getByText('已加上乐事薯片 × 1，保留奥利奥饼干 × 1。',{exact:false}).first().waitFor();
    await page.getByRole('button',{name:/^允许/}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.steps li.done').length >= 8, null, {timeout:15000});
    for(let i=0;i<100;i++) { if(!(await (await page.request.get(base+'/health')).json()).busy) break; await page.waitForTimeout(100); }
    // The task container, not its unscrollable list, follows new progress.
    await page.waitForFunction(()=>{const el=document.querySelector('.task');return el&&el.scrollHeight-el.clientHeight-el.scrollTop<35},null,{timeout:5000});
    const scrolled = await page.locator('.task').evaluate(el=>({top:el.scrollTop,max:el.scrollHeight-el.clientHeight}));
    check(scrolled.max-scrolled.top < 35, 'Progress did not follow bottom');
    check(await page.getByText('机器人通信',{exact:true}).count()===0,'Staff protocol is on visitor page');
    await page.waitForTimeout(400); await page.reload();
    await page.getByText('聊天记录已找回。继续取物时，请再说一下完整需求。',{exact:true}).waitFor();
    check(await page.locator('.msg.user').count()===2,'Refresh changed active messages: '+JSON.stringify(await page.locator('.msg.user').allTextContents()));
    check(await page.getByRole('alertdialog').count()===0,'Refresh restored stale confirmation');
    await page.getByRole('button',{name:'新对话',exact:true}).click();
    await send('你是谁'); await page.locator('.answer').filter({hasText:'我是布鲁'}).waitFor();
    await page.locator('.sb-item').filter({hasText:'拿一包奥利奥'}).click();
    await page.getByText('历史对话',{exact:true}).waitFor();
    check(await page.locator('.conv-composer').count()===0,'History is editable');
    await page.locator('.sb-item').filter({hasText:'你是谁'}).click();
    await page.locator('.answer').filter({hasText:'我是布鲁'}).waitFor();
    await page.clock.install(); await page.clock.fastForward(65000);
    check(await page.locator('.view-session').count()===1,'Idle timer returned home');
    const operator = await testContext.newPage();
    try {
      await operator.goto(base+'/operator');
      await operator.getByLabel('工作人员口令').fill('wrong'); await operator.getByRole('button',{name:'进入工作台'}).click();
      await operator.getByRole('status').filter({hasText:'口令'}).waitFor();
      await operator.getByLabel('工作人员口令').fill('acceptance-only'); await operator.getByRole('button',{name:'进入工作台'}).click();
      await operator.locator('tbody tr').first().waitFor();
      check(await operator.locator('tbody tr').count()===10,'Staff catalogue incomplete');
      operator.once('dialog',d=>d.accept());
      await operator.locator('tbody tr').filter({hasText:'乐事薯片'}).getByRole('button',{name:'恢复库存',exact:true}).click();
      await operator.getByRole('status').filter({hasText:'库存已恢复'}).waitFor();
      const stock=await (await operator.request.get(base+'/api/operator/inventory',{headers:staff})).json();
      check(stock.find(i=>i.id==='shupian').count===3,'Staff restore not applied');
      await operator.getByRole('button',{name:'机器人通信',exact:true}).click();
      const downloadPromise=operator.waitForEvent('download');
      await operator.getByRole('button',{name:'下载记录'}).click();
      const download=await downloadPromise;
      check(download.suggestedFilename().endsWith('.zip'),'Download missing');
    } finally { await operator.close(); }
    return {orderUpdated:true,confirmation180:true,progressFollows:true,historyRestored:true,historyReadOnly:true,noIdleHome:true,staffOnly:true,stockRestored:true,download:true};
  } finally { await testContext.close(); }
}
