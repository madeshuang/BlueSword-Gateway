async root => {
  const testContext = await root.context().browser().newContext();
  const page = await testContext.newPage(), base = new URL(root.url()).origin;
  const check = (ok, message) => { if (!ok) throw Error(message); };
  let boot = 'boot-A', socket, recovery = false;
  const send = event => socket.send(JSON.stringify(event));
  try {
    await page.route('**/api/speech', r=>r.fulfill({json:{configured:false}}));
    await page.routeWebSocket('**/ws', ws=>{
      socket=ws;
      send({type:'device',online:true,name:'受控重启验证'});
      send({type:'backend',mode:'lanjian_http',boot_id:boot,show_camera:false,recovery_required:recovery});
      if(recovery) send({type:'task',task:{id:'needs-check',title:'请核对上次任务',status:'interrupted',recovery_required:true,steps:[]}});
      send({type:'phase',phase:recovery?'listening':'idle'});
    });
    await page.goto(base);await page.evaluate(()=>localStorage.clear());await page.reload();
    const connected=()=>page.getByText('已连接',{exact:true}).waitFor();
    const say=async text=>{await page.getByRole('textbox').fill(text);await page.getByRole('textbox').press('Enter');await page.waitForTimeout(350);};
    await connected();await say('重启前的对话');
    await page.reload();await connected();
    check(await page.locator('.msg.user').innerText()==='重启前的对话','Refresh lost conversation');
    boot='boot-B';await socket.close();
    await page.getByText('未连接',{exact:true}).waitFor();await connected();
    check(await page.locator('.view-session').count()===1,'Live reconnect jumped home');
    await page.waitForTimeout(350);
    recovery=true;
    // Normal navigation represents reopening; page.reload above must remain distinct.
    await page.goto(base+'/?reopened=1');await connected();
    await page.locator('.view-home').waitFor();
    check(await page.locator('.sb-item').filter({hasText:'重启前的对话'}).count()===1,'Previous conversation not archived exactly once');
    await page.getByText('请核对上次任务',{exact:true}).waitFor();
    check(await page.getByText('现场协助',{exact:true}).count()===1,'Recovery controls hidden on home');
    await page.locator('.sb-item').filter({hasText:'重启前的对话'}).click();
    await page.getByText('历史对话',{exact:true}).waitFor();
    await page.getByRole('button',{name:'新对话',exact:true}).click();
    await say('新启动后的对话');
    await page.goto(base+'/?reopened=2');await connected();
    check(await page.locator('.view-session').count()===1,'Same-boot reopen unexpectedly reset');
    check(await page.locator('.msg.user').innerText()==='新启动后的对话','Same-boot reopen lost text');
    boot='boot-C';await page.reload();await connected();
    check(await page.locator('.view-session').count()===1,'Reload after backend restart jumped home');
    check(await page.locator('.msg.user').innerText()==='新启动后的对话','Reload after restart lost text');
    return {refreshPreserves:true,reconnectPreserves:true,reopenAfterRestartGoesHome:true,historyPreserved:true,recoveryVisible:true,sameBootReopenPreserves:true,reloadAfterRestartPreserves:true};
  } finally { await testContext.close(); }
}
