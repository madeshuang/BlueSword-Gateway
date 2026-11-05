async root => {
  const context=await root.context().browser().newContext({viewport:{width:1920,height:1080}});
  const page=await context.newPage(), base=new URL(root.url()).origin;
  let socket;
  const send=event=>socket.send(JSON.stringify(event));
  const check=(ok,msg)=>{if(!ok)throw Error(msg)};
  try {
    await page.route('**/api/speech',r=>r.fulfill({json:{configured:false}}));
    await page.routeWebSocket('**/ws',ws=>{
      socket=ws;
      send({type:'device',online:true,name:'进度提示验证'});
      send({type:'backend',mode:'lanjian_http',boot_id:'reminder-test',show_camera:false,recovery_required:false});
      send({type:'phase',phase:'acting'});
    });
    await page.goto(base);await page.getByText('已连接',{exact:true}).waitFor();
    const timestamp=Date.now()/1000;
    const task={id:'reminder-test',title:'取物',status:'running',created_at:timestamp-80,last_progress_at:timestamp-61,
      steps:[{id:'vlm:1:arrived_shelf',label:'第1件 · 到达货架',status:'done',startedAt:timestamp-61}]};
    send({type:'task',task});
    await page.getByText('进度暂未更新',{exact:true}).waitFor();
    const feedback=page.locator('.task-feedback'), first=await feedback.locator('p').first().innerText();
    const firstSeconds=Number(first.match(/已过 (\d+) 秒/)[1]);
    check(!/回报|失败|故障|卡住/.test(first),'Misleading wording');
    await page.waitForTimeout(2200);
    const second=await feedback.locator('p').first().innerText(), secondSeconds=Number(second.match(/已过 (\d+) 秒/)[1]);
    check(secondSeconds>firstSeconds,'Seconds did not update automatically');
    send({type:'task',task:{...task,last_progress_at:Date.now()/1000,steps:[...task.steps,
      {id:'vlm:1:target_located',label:'第1件 · 找到物品',status:'done',startedAt:Date.now()/1000}]}});
    await feedback.waitFor({state:'hidden'});
    await page.getByText('等待进度更新…',{exact:true}).waitFor();
    return {controlledWebSocket:true,firstSeconds,secondSeconds,updatesAutomatically:true,newProgressClearsReminder:true};
  } finally {await context.close()}
}
