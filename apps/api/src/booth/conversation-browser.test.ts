import { afterEach, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { resolve } from "node:path";
import { createBoothApplication } from "./server.js";
import { readBoothConfig } from "./config.js";

let browser: Browser | undefined;
let app: ReturnType<typeof createBoothApplication> | undefined;
afterEach(async () => {
  await browser?.close();
  browser = undefined;
  await app?.close();
  app = undefined;
});

async function setup(beforeAdvice?: () => Promise<void>, reply = "推荐这件物品，请核对数量后确认。", mode: "http" | "simulator" = "http", suggestSelection = true, products = readBoothConfig().products, intent?: import("./conversation-intent.js").ConversationIntent) {
  const config = {
    ...readBoothConfig(),
    products,
    mode,
    manualRobot: mode === "simulator",
    databasePath: ":memory:",
    catalogConfirmed: true,
    dispatchUrl: "http://127.0.0.1:1/controlled-robot",
    openaiKey: "test-only",
    operatorToken: "test-only",
  };
  let dispatches = 0;
  const selected = config.products[0]!;
  app = createBoothApplication(config, {
    webDirectory: resolve("apps/web/dist"),
    transport: async () => {
      dispatches++;
      return Response.json({ success: true });
    },
    assistant: {
      advise: async () => {
        await beforeAdvice?.();
        return {
          reply,
          intent: intent ?? (suggestSelection ? {kind:"choose" as const,items:[{productId:selected.id,count:1}]} : null),
          selection: null,
          taskStatusQuery: false,
        };
      },
    },
  });
  const port = await app.listen(0);
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(4000);
  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByRole("heading", { name: "你好，今天想体验什么？" }).waitFor();
  return { page, selected, dispatches: () => dispatches };
}

it.each(["http", "simulator"] as const)("%s：模型建议只打开核对弹窗，取消不发单，确认只发一单并接收完成结果", async (mode) => {
  const { page, dispatches } = await setup(undefined, undefined, mode);
  await page.locator("textarea").fill("帮我挑一份实用的纪念品，数量一件。");
  await page.getByRole("button",{name:"发送需求",exact:true}).click();
  const dialog = page.getByRole("dialog", { name: "确认这份取物清单" });
  await dialog.waitFor();
  expect(dispatches()).toBe(0);
  await page.screenshot({ path: ".tmp/ui-preview/order-confirmation.png" });
  await dialog.getByRole("button", { name: "暂不取物" }).click();
  await page.screenshot({ path: ".tmp/ui-preview/conversation.png" });
  expect(dispatches()).toBe(0);
  await page.getByRole("button", { name: "核对并确认", exact: true }).click();
  await dialog.getByRole("button", { name: "确认取物", exact: true }).click();
  await page.getByRole("button", { name: /查看取物进度/ }).waitFor();
  await expect.poll(dispatches).toBe(1);
  await expect
    .poll(() => app!.service.snapshot().active?.status)
    .toBe("executing");
  app!.service.finished();
  await page.getByRole("dialog", { name: "取物已完成" }).waitFor();
  expect(dispatches()).toBe(1);
}, 20000);

it.each(["http", "simulator"] as const)("%s：首页手动核对后关闭弹窗仍保留聊天清单，重新核对不重复消息或发单", async (mode) => {
  const { page, selected, dispatches } = await setup(undefined, undefined, mode);
  await page.getByRole("button", { name: "浏览物品", exact: true }).click();
  await page.getByRole("button", { name: `选择${selected.name}`, exact: true }).click();
  await page.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  expect(await page.locator(".conversation-welcome").count()).toBe(1);
  expect(await page.locator(".selection-proposal").count()).toBe(0);
  await page.getByRole("button", { name: "浏览物品", exact: true }).click();
  await page.getByRole("button", { name: "核对选择", exact: true }).click();
  await page.getByRole("dialog", { name: "确认这份取物清单" }).waitFor();
  await page.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  expect(await page.locator(".conversation-welcome").count()).toBe(0);
  expect(await page.locator(".assistant-message .selection-proposal").count()).toBe(1);
  const messages = await page.locator(".assistant-message").count();
  await page.getByRole("button", { name: "核对并确认", exact: true }).click();
  await page.keyboard.press("Escape");
  expect(await page.locator(".assistant-message").count()).toBe(messages);
  expect(dispatches()).toBe(0);
  await page.screenshot({ path: ".tmp/ui-preview/manual-selection-chat.png" });
  await page.getByRole("button", { name: "开启新对话", exact: true }).click();
  await page.getByRole("dialog", { name: "开启一段新对话？" }).getByRole("button", { name: "开启新对话", exact: true }).click();
  expect(await page.locator(".conversation-welcome").count()).toBe(1);
  expect(await page.locator(".selection-proposal").count()).toBe(0);
}, 15000);

it.each(["http", "simulator"] as const)("%s：对话追加使用页面当前清单，同种一加一可确认两件", async mode => {
  const {page,selected,dispatches}=await setup(undefined,undefined,mode);
  await page.getByRole('button',{name:'浏览物品',exact:true}).click();
  await page.getByRole('button',{name:`选择${selected.name}`,exact:true}).click();
  await page.getByRole('button',{name:'核对选择',exact:true}).click();
  await page.getByRole('button',{name:'暂不取物',exact:true}).click();
  await page.locator('textarea').fill(`再来一件${selected.name}。`);
  await page.getByRole('button',{name:'发送需求',exact:true}).click();
  const order=page.getByRole('dialog',{name:'确认这份取物清单'});
  await order.getByText('共 2 件',{exact:true}).waitFor();
  expect(await order.locator('output').innerText()).toBe('2');
  expect(dispatches()).toBe(0);
  await order.getByRole('button',{name:'确认取物',exact:true}).click();
  await expect.poll(dispatches).toBe(1);
  expect(app!.service.snapshot().active!.items).toEqual([expect.objectContaining({productId:selected.id,count:2})]);
},15000);

it.each(["http", "simulator"] as const)("%s：补货后省略追加更新唯一清单，旧缺货历史不阻止选取",async mode=>{
  const source=readBoothConfig().products[0]!;
  const product={...source,id:'shuttlecock_tube',name:'羽毛球',initialStock:2,maxCount:2};
  const {page,dispatches}=await setup(undefined,'羽毛球已取完，暂时无法取物。',mode,false,[product]);
  for(let cycle=0;cycle<2;cycle++) {
    for(let i=0;i<2;i++) {
      await app!.service.dispatch([{productId:product.id,count:1}],`browser-refill-${cycle}-${i}`);
      app!.service.finished();
    }
    if(cycle===0)app!.service.resetStock(product.id,'已核对并补满库存');
  }
  await page.reload();
  await page.getByRole('heading',{name:'你好，今天想体验什么？'}).waitFor();
  const send=async(input:string)=>{
    await page.locator('textarea').fill(input);
    await page.getByRole('button',{name:'发送需求',exact:true}).click();
  };
  await send('一桶羽毛球');
  await page.locator('.assistant-bubble').filter({hasText:'已取完'}).waitFor();
  app!.service.resetStock(product.id,'已核对并补满库存');
  await send('一桶羽毛球');
  const dialog=page.getByRole('dialog',{name:'确认这份取物清单'});
  await dialog.getByText('共 1 件',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'暂不取物',exact:true}).click();
  await send('再来一桶');
  await dialog.getByText('共 2 件',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'暂不取物',exact:true}).click();
  expect(await page.locator('.selection-proposal').count()).toBe(1);
  expect(await page.locator('.assistant-message').last().locator('.selection-proposal').innerText()).toContain('× 2');
  expect(app!.service.products()[0]!.availableCount).toBe(2);
  expect(dispatches()).toBe(4);
  await send('再来一桶');
  await page.locator('.assistant-bubble').last().filter({hasText:'最多两件'}).waitFor();
  expect(await page.getByRole('dialog').count()).toBe(0);
  expect(await page.locator('.selection-proposal').innerText()).toContain('× 2');
  await page.getByRole('button',{name:'核对并确认',exact:true}).click();
  await dialog.getByRole('button',{name:'确认取物',exact:true}).click();
  await expect.poll(dispatches).toBe(5);
  expect(app!.service.products()[0]!.availableCount).toBe(0);
},20000);

it.each(["http", "simulator"] as const)("%s：新物品不静默替换原清单，支持按钮追加及文字确认替换",async mode=>{
  const {page,selected,dispatches}=await setup(undefined,undefined,mode);
  const original=app!.service.snapshot().products[1]!;
  await page.getByRole('button',{name:'浏览物品',exact:true}).click();
  await page.getByRole('button',{name:`选择${original.name}`,exact:true}).click();
  await page.getByRole('button',{name:'核对选择',exact:true}).click();
  await page.getByRole('button',{name:'暂不取物',exact:true}).click();
  await page.locator('textarea').fill(`${selected.name}一件`);
  await page.getByRole('button',{name:'发送需求',exact:true}).click();
  const choices=page.getByRole('group',{name:'追加或替换清单'});
  await choices.waitFor();
  expect(await page.getByRole('dialog').count()).toBe(0);
  await page.screenshot({path:`.tmp/ui-preview/selection-clarification-${mode}.png`});
  await choices.getByRole('button',{name:'一起取，共 2 件',exact:true}).click();
  const order=page.getByRole('dialog',{name:'确认这份取物清单'});
  await order.getByText('共 2 件',{exact:true}).waitFor();
  expect(await order.getByText(original.name,{exact:true}).isVisible()).toBe(true);
  expect(await order.getByText(selected.name,{exact:true}).isVisible()).toBe(true);
  await order.getByRole('button',{name:'暂不取物',exact:true}).click();
  await page.locator('textarea').fill(`${selected.name}一件`);
  await page.getByRole('button',{name:'发送需求',exact:true}).click();
  await choices.waitFor();
  await page.locator('textarea').fill('换成新的');
  await page.getByRole('button',{name:'发送需求',exact:true}).click();
  await order.getByText('共 1 件',{exact:true}).waitFor();
  expect(await order.getByText(original.name,{exact:true}).count()).toBe(0);
  expect(dispatches()).toBe(0);
},20000);

it.each(["http", "simulator"] as const)("%s：聊天与清单分离，仅清单变化时移到本次回复下方", async mode => {
  const {page,selected,dispatches}=await setup(undefined,"还可以看看其他物品。",mode,false);
  await page.getByRole('button',{name:'浏览物品',exact:true}).click();
  await page.getByRole('button',{name:`选择${selected.name}`,exact:true}).click();
  await page.getByRole('button',{name:'核对选择',exact:true}).click();
  await page.getByRole('button',{name:'暂不取物',exact:true}).click();
  const card=page.getByRole('region',{name:'待确认取物清单'});
  await card.waitFor();
  const firstReply=page.locator('.assistant-message').first();
  await page.locator('textarea').fill('还有什么推荐？');
  await page.getByRole('button',{name:'发送需求',exact:true}).click();
  await page.locator('.assistant-bubble').getByText('还可以看看其他物品。',{exact:true}).waitFor();
  expect(await card.count()).toBe(1);
  expect(await firstReply.locator('.selection-proposal').count()).toBe(1);
  expect(await card.getByText('还可以看看其他物品。',{exact:true}).count()).toBe(0);
  expect(await page.getByRole('dialog').count()).toBe(0);
  await page.locator('textarea').fill(`再来一件${selected.name}`);
  await page.getByRole('button',{name:'发送需求',exact:true}).click();
  await page.getByRole('dialog',{name:'确认这份取物清单'}).getByText('共 2 件',{exact:true}).waitFor();
  await page.getByRole('button',{name:'暂不取物',exact:true}).click();
  expect(await card.count()).toBe(1);
  expect(await firstReply.locator('.selection-proposal').count()).toBe(0);
  expect(await card.locator('.recommendation-quantity').innerText()).toBe('× 2');
  expect(await page.locator('.assistant-message').last().locator('.assistant-bubble').innerText()).toContain('× 2');
  expect(await page.locator('.assistant-message').last().locator('.selection-proposal').count()).toBe(1);
  const ownerIndex=await page.locator('.assistant-message').count()-1;
  await page.locator('textarea').fill('谢谢');
  await page.getByRole('button',{name:'发送需求',exact:true}).click();
  await expect.poll(()=>page.locator('.assistant-message').count()).toBe(ownerIndex+2);
  expect(await page.locator('.assistant-message').nth(ownerIndex).locator('.selection-proposal').count()).toBe(1);
  expect(await page.locator('.assistant-message').last().locator('.selection-proposal').count()).toBe(0);
  expect(dispatches()).toBe(0);
  await page.screenshot({path:`.tmp/ui-preview/separate-selection-${mode}.png`});
},15000);

it.each(["http", "simulator"] as const)("%s：重新明确选择相同数量时移动唯一清单", async mode => {
  const {page}=await setup(undefined,undefined,mode);
  for (let round=0;round<2;round++) {
    await page.locator('textarea').fill('帮我选一件物品');
    await page.getByRole('button',{name:'发送需求',exact:true}).click();
    await page.getByRole('dialog',{name:'确认这份取物清单'}).waitFor();
    await page.getByRole('button',{name:'暂不取物',exact:true}).click();
  }
  expect(await page.locator('.selection-proposal').count()).toBe(1);
  expect(await page.locator('.assistant-message').first().locator('.selection-proposal').count()).toBe(0);
  expect(await page.locator('.assistant-message').last().locator('.selection-proposal').count()).toBe(1);
},15000);

it.each(["http", "simulator"] as const)("%s：数量追问承接当前物品，追加后消息清单一致且只保留一张卡", async mode => {
  const product=readBoothConfig().products[0]!;
  const {page,dispatches}=await setup(undefined,`${product.name}目前有货，需要几份？`,mode,false);
  const original=app!.service.snapshot().products[1]!;
  await page.getByRole('button',{name:'浏览物品',exact:true}).click();
  await page.getByRole('button',{name:`选择${original.name}`,exact:true}).click();
  await page.getByRole('button',{name:'核对选择',exact:true}).click();
  await page.getByRole('button',{name:'暂不取物',exact:true}).click();
  await page.locator('textarea').fill(`有${product.name}吗？`);
  await page.getByRole('button',{name:'发送需求',exact:true}).click();
  await page.locator('.assistant-bubble').getByText(`${product.name}目前有货，需要几份？`,{exact:true}).waitFor();
  await page.locator('textarea').fill('一份');
  await page.getByRole('button',{name:'发送需求',exact:true}).click();
  await page.getByRole('group',{name:'追加或替换清单'}).getByRole('button',{name:'一起取，共 2 件',exact:true}).click();
  await page.getByRole('dialog',{name:'确认这份取物清单'}).getByText('共 2 件',{exact:true}).waitFor();
  await page.getByRole('button',{name:'暂不取物',exact:true}).click();
  expect(await page.locator('.selection-proposal').count()).toBe(1);
  const last=page.locator('.assistant-message').last();
  expect(await last.locator('.assistant-bubble').innerText()).toContain(product.name);
  expect(await last.locator('.selection-proposal').innerText()).toContain(original.name);
  expect(await last.locator('.selection-proposal').innerText()).toContain(product.name);
  expect(dispatches()).toBe(0);
},15000);

it.each(["http", "simulator"] as const)("%s：简称追加、删除及清空清单保持一致，不误发任务", async mode => {
  const source=readBoothConfig().products[0]!;
  const {page,dispatches}=await setup(undefined,undefined,mode,true,[
    {...source,id:'chips',name:'乐事薯片',initialStock:3,maxCount:2},
    {...source,id:'yogurt',name:'安慕希酸奶',initialStock:3,maxCount:2},
  ]);
  const chips=app!.service.snapshot().products.find(p=>p.name.endsWith('薯片'))!;
  const yogurt=app!.service.snapshot().products.find(p=>p.name.endsWith('酸奶'))!;
  await page.getByRole('button',{name:'浏览物品',exact:true}).click();
  await page.getByRole('button',{name:`选择${chips.name}`,exact:true}).click();
  await page.getByRole('button',{name:`选择${yogurt.name}`,exact:true}).click();
  await page.getByRole('button',{name:'核对选择',exact:true}).click();
  await page.getByRole('button',{name:'暂不取物',exact:true}).click();
  const send=async(input:string)=>{
    await page.locator('textarea').fill(input);
    await page.getByRole('button',{name:'发送需求',exact:true}).click();
  };
  await send('不要酸奶了');
  await page.locator('.assistant-bubble').getByText(`已去掉${yogurt.name}，保留${chips.name} × 1。`,{exact:true}).waitFor();
  if(await page.getByRole('dialog').count()) await page.getByRole('button',{name:'暂不取物',exact:true}).click();
  expect(await page.locator('.selection-choices').count()).toBe(0);
  expect(await page.locator('.selection-proposal').innerText()).not.toContain(yogurt.name);
  await send('再来一份薯片');
  await page.getByRole('dialog',{name:'确认这份取物清单'}).getByText('共 2 件',{exact:true}).waitFor();
  await page.getByRole('button',{name:'暂不取物',exact:true}).click();
  expect(await page.locator('.selection-proposal').count()).toBe(1);
  expect(await page.locator('.assistant-message').last().locator('.selection-proposal').innerText()).toContain('× 2');
  await send('不要薯片了');
  await page.locator('.assistant-bubble').getByText(`已去掉${chips.name}，当前清单已清空。`,{exact:true}).waitFor();
  expect(await page.locator('.selection-proposal').count()).toBe(0);
  expect(await page.getByRole('dialog').count()).toBe(0);
  expect(dispatches()).toBe(0);
},15000);

it.each(["http", "simulator"] as const)("%s：截图简称数量回归，打火机吧后回答一份直接出现清单",async mode=>{
  const source=readBoothConfig().products[0]!;
  const {page,dispatches}=await setup(undefined,'打火机要取几件？每单最多两件。',mode,false,[{...source,id:'lighter',name:'USB防风打火机',initialStock:3,maxCount:2}]);
  await page.locator('textarea').fill('打火机吧');
  await page.getByRole('button',{name:'发送需求',exact:true}).click();
  await page.locator('.assistant-bubble').getByText('打火机要取几件？每单最多两件。',{exact:true}).waitFor();
  await page.locator('textarea').fill('一份');
  await page.getByRole('button',{name:'发送需求',exact:true}).click();
  const order=page.getByRole('dialog',{name:'确认这份取物清单'});
  await order.getByText('USB防风打火机',{exact:true}).waitFor();
  expect(await order.getByText('共 1 件',{exact:true}).isVisible()).toBe(true);
  await order.getByRole('button',{name:'暂不取物',exact:true}).click();
  expect(await page.locator('.selection-proposal').count()).toBe(1);
  expect(await page.locator('.assistant-bubble').last().innerText()).toContain('USB防风打火机 × 1');
  expect(await page.getByText('你想取哪一种物品？请告诉我物品名称和数量。',{exact:true}).count()).toBe(0);
  expect(dispatches()).toBe(0);
},15000);

it("手动选择与数量调整保留，确认前库存变更阻止发单，移动端不溢出", async () => {
  const { page, selected, dispatches } = await setup();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "浏览并选择物品" }).click();
  await page
    .getByRole("button", { name: `选择${selected.name}`, exact: true })
    .click();
  await page.getByRole("button", { name: "核对选择", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认这份取物清单" });
  await dialog.waitFor();
  await dialog
    .getByRole("button", { name: `增加${selected.name}数量` })
    .click();
  expect(await dialog.getByText("共 2 件", { exact: true }).isVisible()).toBe(
    true,
  );
  const stock = await app!.service.dispatch(
    [{ productId: selected.id, count: 2 }],
    "outside-request",
  );
  expect(stock.status).toBe("executing");
  app!.service.finished();
  await page
    .getByRole("dialog", { name: "取物已完成" })
    .getByRole("button", { name: "知道了" })
    .click();
  await page.getByRole("button", { name: "核对并确认", exact: true }).click();
  await dialog.getByText(/库存不足/).waitFor();
  await expect
    .poll(() =>
      dialog.getByRole("button", { name: "确认取物", exact: true }).isEnabled(),
    )
    .toBe(false);
  expect(dispatches()).toBe(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  expect(await dialog.isVisible()).toBe(false);
}, 20000);

it("延迟的模型建议不会覆盖手动选择或擅自弹出确认", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });


  const { page, dispatches } = await setup(() => gate);
  await page.locator("textarea").fill("帮我挑一份实用的纪念品，数量一件。");
  await page.getByRole("button",{name:"发送需求",exact:true}).click();
  await page.getByRole("status", { name: "回复状态" }).waitFor();
  await page.getByRole("button", { name: "浏览并选择物品" }).click();
  const manual = app!.service.snapshot().products[1]!;
  await page
    .getByRole("button", { name: `选择${manual.name}`, exact: true })
    .click();
  await page.getByRole("button", { name: "稍后再选", exact: true }).click();
  release();
  await page
    .getByText("已记下：矿泉水 × 1，共 1 件。", { exact: true })
    .waitFor();
  expect(await page.getByRole("dialog").count()).toBe(0);
  await page.getByRole("button", { name: "核对并确认", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认这份取物清单" });
  expect(await dialog.getByText(manual.name, { exact: true }).isVisible()).toBe(
    true,
  );
  expect(dispatches()).toBe(0);
}, 20000);

it("工作人员补货需要凭据、现场核对和第二次确认", async () => {
  const { page, selected, dispatches } = await setup();
  await app!.service.dispatch(
    [{ productId: selected.id, count: 1 }],
    "stock-test",
  );
  app!.service.finished();
  const available = () =>
    app!.service.snapshot().products.find((p) => p.id === selected.id)!
      .availableCount;
  const before = available();
  await page
    .getByRole("dialog", { name: "取物已完成" })
    .getByRole("button", { name: "知道了" })
    .click();
  await page.getByRole("button", { name: "工作人员", exact: true }).click();
  await page.getByLabel("工作人员凭据", { exact: true }).fill("test-only");
  await page.getByText("库存补货", { exact: true }).click();
  const reset = page.getByRole("button", {
    name: "重置所选物品库存",
    exact: true,
  });
  expect(await reset.isEnabled()).toBe(false);
  await page.getByLabel("已核对并补满所选物品", { exact: true }).check();
  await reset.click();
  await page.getByRole("dialog", { name: "确认工作人员操作" }).waitFor();
  expect(available()).toBe(before);
  await page.getByRole("button", { name: "确认操作", exact: true }).click();
  await page.getByText("库存已更新", { exact: true }).waitFor();
  expect(available()).toBe(before + 1);
  expect(dispatches()).toBe(1);
}, 20000);

it("超时执行任务需工作人员现场核对并二次确认后解除", async () => {
  const { page, selected } = await setup();
  const task = await app!.service.dispatch(
    [{ productId: selected.id, count: 1 }],
    "overdue-ui",
  );
  app!.service.storage.set("booth_tasks", task.id, {
    ...task,
    createdAt: new Date(Date.now() - 300000).toISOString(),
  });
  await page.reload();
  await page
    .getByRole("dialog", { name: "取物等待时间较长" })
    .getByRole("button", { name: "知道了" })
    .click();
  await page.getByRole("button", { name: "工作人员", exact: true }).click();
  await page.getByLabel("工作人员凭据", { exact: true }).fill("test-only");
  await page
    .getByLabel("已现场核对机器人停止及物品情况", { exact: true })
    .check();
  await page
    .getByRole("button", { name: "解除新任务限制", exact: true })
    .click();
  expect(app!.service.snapshot().active?.status).toBe("executing");
  await page
    .getByRole("dialog", { name: "确认工作人员操作" })
    .getByRole("button", { name: "确认操作", exact: true })
    .click();
  await page.getByText("已解除新任务限制", { exact: true }).waitFor();
  expect(app!.service.snapshot().active).toBeNull();
  expect(app!.service.snapshot().tasks[0]!.status).toBe("resolved");
}, 20000);


it("品牌标识在长对话、侧栏收起和手机上保持可见", async () => {
  const { page } = await setup(undefined, "我是布鲁，很高兴为你介绍兰剑展台的物品。\n\n".repeat(28));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const logo = page.locator(".header-assistant-brand");
  const assertBrand = async () => {
    expect(await logo.innerText()).toBe("BLUE BRAIN · 智能取物体验");
    expect(await logo.locator("img").count()).toBe(0);
    const bounds = await logo.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThan(120);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator(".conversation-composer").evaluate(el => el.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
  };
  await assertBrand();
  expect(await page.locator(".conversation-app").evaluate(el => getComputedStyle(el).getPropertyValue("--brand").trim())).toBe("#007687");
  await page.screenshot({ path: ".tmp/ui-preview/desktop-welcome.png" });
  await page.locator("textarea").fill("帮我挑一份实用的纪念品，数量一件。");
  await page.getByRole("button",{name:"发送需求",exact:true}).click();
  await page.getByRole("dialog", {name: "确认这份取物清单"}).getByRole("button", {name: "暂不取物"}).click();
  await page.locator(".conversation-scroll").evaluate(el => { el.scrollTop = el.scrollHeight; });
  await assertBrand();
  await page.screenshot({ path: ".tmp/ui-preview/desktop-conversation.png" });
  await page.getByRole("button", {name: "收起侧边栏"}).click();
  await assertBrand();
  await page.setViewportSize({width: 390, height: 844});
  await assertBrand();
  await page.screenshot({ path: ".tmp/ui-preview/mobile-conversation.png" });
  await page.getByRole("button", {name: "打开导航"}).click();
  await page.getByRole("dialog").getByRole("button", {name: "开启新对话", exact: true}).click();
  await page.getByRole("dialog").getByRole("button", {name: "开启新对话", exact: true}).click();
  await page.getByRole("heading", {name: "你好，今天想体验什么？"}).waitFor();
  await assertBrand();
  await page.screenshot({ path: ".tmp/ui-preview/mobile-welcome.png" });
  await page.setViewportSize({width: 320, height: 640});
  await assertBrand();
  expect(errors).toEqual([]);
}, 20000);

it("工作人员确认期间任务变化时拒绝处理新任务", async () => {
  const { page, selected } = await setup();
  await app!.service.dispatch([{productId: selected.id, count: 1}], "recovery-first");
  await page.getByRole("button", {name: "工作人员", exact: true}).click();
  await page.getByLabel("工作人员凭据", {exact: true}).fill("test-only");
  await page.getByLabel("已现场核对机器人停止及物品情况", {exact: true}).check();
  await page.getByRole("button", {name: "解除新任务限制", exact: true}).click();
  await page.getByRole("dialog", {name: "确认工作人员操作"}).waitFor();
  app!.service.finished();
  const next = await app!.service.dispatch([{productId: selected.id, count: 1}], "recovery-second");
  await page.getByRole("button", {name: "确认操作", exact: true}).click();
  await page.getByRole("alert").filter({hasText: "任务或告警已变化"}).waitFor();
  expect(app!.service.snapshot().active?.id).toBe(next.id);
  expect(app!.service.snapshot().active?.status).toBe("executing");
  expect(await page.getByRole("button", {name: "确认操作", exact: true}).isEnabled()).toBe(false);
}, 20000);

it("不同显示器下内容放大且不横向溢出，输入框和标识保持可见", async () => {
  const { page } = await setup();
  for (const [width, height] of [[320,640],[390,844],[768,1024],[1024,768],[1366,768],[1440,900],[1920,1080],[2560,1440],[3840,2160],[1366,600]]) {
    await page.setViewportSize({width: width!, height: height!});
    const layout = await page.evaluate(() => {
      const scroll = document.querySelector('.conversation-scroll')!;
      const composer = document.querySelector('.conversation-composer')!.getBoundingClientRect();
      const logo = document.querySelector('.header-assistant-brand')!.getBoundingClientRect();
      return {
        pageFits: document.documentElement.scrollWidth <= innerWidth,
        contentFits: scroll.scrollWidth <= scroll.clientWidth,
        inputVisible: composer.bottom <= innerHeight && composer.top > logo.bottom,
        logoVisible: logo.top >= 0 && logo.bottom <= innerHeight,
        welcomeVisible: document.querySelector(".welcome-brand-lockup")!.getBoundingClientRect().top >= scroll.getBoundingClientRect().top - 1,
        contentWidth: document.querySelector('.conversation-column')!.getBoundingClientRect().width,
      };
    });
    expect(layout.welcomeVisible, `${width}: welcome clipped`).toBe(true);
    expect(layout.pageFits, `${width}: page overflow`).toBe(true);
    expect(layout.contentFits, `${width}: content overflow`).toBe(true);
    expect(layout.inputVisible, `${width}: input hidden`).toBe(true);
    expect(layout.logoVisible, `${width}: logo hidden`).toBe(true);
    if (width! >= 1920) expect(layout.contentWidth).toBeGreaterThan(880);
    if ([390,1366,1920,3840].includes(width!)) await page.screenshot({path: `.tmp/ui-preview/scaled-${width}x${height}.png`});
  }
  await page.setViewportSize({width:1920,height:1080});
  await page.locator("textarea").fill("帮我挑一份实用的纪念品，数量一件。");
  await page.getByRole("button",{name:"发送需求",exact:true}).click();
  await page.getByRole('dialog',{name:'确认这份取物清单'}).getByRole('button',{name:'暂不取物'}).click();
  expect(await page.locator('.assistant-identity').last().innerText()).toBe('兰剑助手·布鲁');
  await page.screenshot({path: '.tmp/ui-preview/scaled-conversation.png'});
}, 20000);
it.each(["http", "simulator"] as const)("%s：日常聊天只显示轻量等待，回复后不留思考卡或任务清单", async (mode) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const {page, dispatches} = await setup(() => gate, "你好，我是布鲁，很高兴见到你。", mode, false);
  await page.locator("textarea").fill("你好");
  await page.getByRole("button", {name:"发送需求",exact:true}).click();
  const waiting = page.getByRole("status", {name:"回复状态"});
  await waiting.waitFor();
  expect(await page.locator('.thinking-card, .thinking-skeleton, .task-checklist').count()).toBe(0);
  await page.screenshot({path:`.tmp/ui-preview/chat-waiting-${mode}.png`});
  release();
  await page.getByText("你好，我是布鲁，很高兴见到你。", {exact:true}).waitFor();
  expect(await waiting.count()).toBe(0);
  expect(await page.locator('.thinking-message, .task-checklist, .selection-proposal').count()).toBe(0);
  expect(await page.getByRole('dialog').count()).toBe(0);
  expect(dispatches()).toBe(0);
}, 15000);

it("桌面字号、消息背景与一行等待在回复前后保持正确", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { page } = await setup(() => gate);
  for (const [width, height] of [[1366,768],[1920,1080],[2560,1440],[3840,2160]]) {
    await page.setViewportSize({width:width!, height:height!});
    const layout = await page.evaluate(() => {
      const input = document.querySelector('.conversation-composer')!.getBoundingClientRect();
      const scroll = document.querySelector('.conversation-scroll')!;
      return {fits:document.documentElement.scrollWidth<=innerWidth && scroll.scrollWidth<=scroll.clientWidth,
        inputVisible:input.bottom<=innerHeight && input.top>0,
        font:parseFloat(getComputedStyle(document.querySelector('textarea')!).fontSize)};
    });
    expect(layout.fits, String(width)).toBe(true);
    expect(layout.inputVisible, String(width)).toBe(true);
    expect(layout.font).toBeGreaterThanOrEqual(20.4);
  }
  await page.setViewportSize({width:1920,height:1080});
  expect(await page.locator(".conversation-starters").count()).toBe(0);
  await page.screenshot({path:".tmp/ui-preview/welcome-no-shortcuts.png"});
  await page.locator("textarea").fill("帮我挑一份实用的纪念品，数量一件。");
  await page.getByRole("button",{name:"发送需求",exact:true}).click();
  const thinking=page.getByRole('status',{name:'回复状态'});
  await thinking.getByText('正在回复…',{exact:true}).waitFor();
  expect(await page.locator('.thinking-card, .thinking-skeleton').count()).toBe(0);
  expect((await thinking.boundingBox())!.height).toBeLessThan(50);
  await page.screenshot({path:'.tmp/ui-preview/readable-thinking-desktop.png'});
  release();
  await page.getByRole('dialog',{name:'确认这份取物清单'}).waitFor();
  await page.getByRole('button',{name:'暂不取物',exact:true}).click();
  expect(await thinking.count()).toBe(0);
  expect(await page.getByText('思考结束',{exact:true}).count()).toBe(0);
  expect(await page.locator('.assistant-identity').last().innerText()).toBe('兰剑助手·布鲁');
  const colors=await page.evaluate(()=>['.recommendation-card','.user-message'].map(s=>getComputedStyle(document.querySelector(s)!).backgroundColor));
  expect(colors[0]).not.toBe('rgba(0, 0, 0, 0)');
  expect(colors[0]).not.toBe(colors[1]);
  expect(await page.locator('.assistant-message .assistant-bubble').count()).toBe(1);
  expect(await page.locator('.assistant-bubble').getByText('已记下：矿泉水 × 1，共 1 件。',{exact:true}).isVisible()).toBe(true);
  expect(await page.getByRole('region',{name:'待确认取物清单'}).getByText('已记下：矿泉水 × 1，共 1 件。',{exact:true}).count()).toBe(0);
  expect(await page.getByRole('button',{name:'调整选择',exact:true}).isVisible()).toBe(true);
  expect(await page.locator('.assistant-identity').last().evaluate(el=>getComputedStyle(el.parentElement!).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  await page.screenshot({path:'.tmp/ui-preview/readable-conversation-desktop.png'});
  await page.getByRole('button',{name:'浏览物品',exact:true}).click();
  await page.screenshot({path:'.tmp/ui-preview/readable-catalog-desktop.png'});
}, 20000);
it.each(["http", "simulator"] as const)("%s：任务清单模拟中间进度，支持折叠，故障暂停且完成依赖通知", async (mode) => {
  const {page}=await setup(undefined, undefined, mode);
  await page.setViewportSize({width:1920,height:1080});
  await page.locator("textarea").fill("帮我挑一份实用的纪念品，数量一件。");
  await page.getByRole("button",{name:"发送需求",exact:true}).click();
  await page.getByRole('dialog',{name:'确认这份取物清单'}).getByRole('button',{name:'确认取物',exact:true}).click();
  const checklist=page.getByRole('region',{name:'取物任务清单'});
  await checklist.getByText('已完成 2 / 4',{exact:true}).waitFor({timeout:10000});
  expect(await checklist.locator('.checklist-step.running').innerText()).toContain('机器人正在抓取');
  await page.screenshot({path:'.tmp/ui-preview/task-checklist-executing.png'});
  await checklist.getByText('已完成 3 / 4',{exact:true}).waitFor({timeout:15000});
  expect(await checklist.locator('.checklist-step.running').innerText()).toContain('机器人正在运输');
  expect(app!.service.snapshot().active?.status).toBe('executing');
  await checklist.getByRole('button',{name:'收起',exact:true}).click();
  expect(await checklist.locator('ol').count()).toBe(0);
  await checklist.getByRole('button',{name:'展开',exact:true}).click();
  app!.service.error('抓取故障，请现场核对');
  await checklist.locator('.checklist-status').getByText('需要协助',{exact:true}).waitFor();
  expect(await checklist.locator('.checklist-step.running').count()).toBe(0);
  expect(await checklist.getByText('已完成 3 / 4',{exact:true}).isVisible()).toBe(true);
  expect(await checklist.getByText('已完成 4 / 4',{exact:true}).count()).toBe(0);
  app!.service.finished();
  await checklist.getByText('已完成 4 / 4',{exact:true}).waitFor();
  expect(await checklist.locator('.checklist-step.done').count()).toBe(4);
},20000);


it.each(["http","simulator"] as const)("%s：模型追加意图由程序合并，只更新唯一卡片且确认前不扣库存",async mode=>{
  const source=readBoothConfig().products[0]!;
  const product={...source,id:'shuttlecock_tube',name:'羽毛球',initialStock:3,maxCount:2};
  const {page,dispatches}=await setup(undefined,'不应展示模型的计算文字',mode,false,[product],{kind:'add',items:[{productId:product.id,count:1}]});
  const send=async()=>{
    await page.locator('textarea').fill('帮忙再安排一筒羽毛球吧');
    await page.getByRole('button',{name:'发送需求',exact:true}).click();
  };
  const dialog=page.getByRole('dialog',{name:'确认这份取物清单'});
  await send();await dialog.getByText('共 1 件',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'暂不取物',exact:true}).click();
  await send();await dialog.getByText('共 2 件',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'暂不取物',exact:true}).click();
  expect(await page.locator('.selection-proposal').count()).toBe(1);
  expect(await page.locator('.assistant-message').last().locator('.selection-proposal').innerText()).toContain('× 2');
  expect(await page.getByText('不应展示模型的计算文字',{exact:true}).count()).toBe(0);
  expect(dispatches()).toBe(0);expect(app!.service.products()[0]!.availableCount).toBe(3);
},15000);

it.each(['http','simulator'] as const)('%s：截图问句不弹窗，确定一桶后关闭弹窗，唯一卡片在最新回复下',async mode=>{
  const product={...readBoothConfig().products[0]!,id:'shuttlecock_tube',name:'羽毛球',initialStock:1,maxCount:2};
  const {page,dispatches}=await setup(undefined,undefined,mode,false,[product]);
  const send=async(text:string)=>{
    const before=await page.locator('.assistant-message').count();
    await page.locator('textarea').fill(text);
    await page.getByRole('button',{name:'发送需求',exact:true}).click();
    await expect.poll(()=>page.locator('.assistant-message').count()).toBe(before+1);
  };
  await send('来一桶羽毛球。');
  await page.getByRole('dialog',{name:'确认这份取物清单'}).waitFor();
  await page.getByRole('button',{name:'关闭弹窗',exact:true}).click();
  for(const text of ['能再加一桶吗。','我的意思是能来两桶羽毛球吗？']){
    await send(text);
    expect(await page.locator('.assistant-message').last().innerText()).toContain('只剩 1');
    expect(await page.getByRole('dialog').count()).toBe(0);
    expect(await page.locator('.assistant-message').first().locator('.selection-proposal').count()).toBe(1);
  }
  for(const text of ['行，就来一桶羽毛球吧。','那我就来一桶羽毛球。']){
    await send(text);
    await page.getByRole('dialog',{name:'确认这份取物清单'}).waitFor();
    await page.getByRole('button',{name:'关闭弹窗',exact:true}).click();
    expect(await page.locator('.selection-proposal').count()).toBe(1);
    expect(await page.locator('.assistant-message').last().locator('.selection-proposal').innerText()).toContain('× 1');
    expect(await page.locator('.assistant-message').last().innerText()).not.toContain('无法提供');
  }
  expect(dispatches()).toBe(0);
  expect(app!.service.products()[0]!.availableCount).toBe(1);
  await page.screenshot({path:`.tmp/ui-preview/followup-fixed-${mode}.png`});
},20000);
