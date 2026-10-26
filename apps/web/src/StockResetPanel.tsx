import { useEffect, useState } from "react";
import type { BoothStockProduct } from "@bluesword/contracts";

export function StockResetPanel({ products, disabled, onReset }: {
  products: BoothStockProduct[]; disabled: boolean;
  onReset: (productId: string | null) => Promise<boolean>;
}) {
  const [selectedId,setSelectedId] = useState(products[0]?.id ?? "");
  const [checked,setChecked] = useState(false);
  const all = selectedId === "";
  const product = products.find(p=>p.id===selectedId) ?? products[0];
  const allStock = all ? JSON.stringify(products.map(p=>[p.id,p.availableCount,p.initialStock])) : "";
  useEffect(()=>setChecked(false),[product?.id,product?.availableCount,product?.initialStock,all,allStock]);
  return <section className="operator-stock" aria-label="补货重置">
    <h3>补货重置</h3>
    <p>先核对并补满物品，再重置数量；整批补货可选择全部物品。重启服务会保留剩余库存。</p>
    <label>已补货物品<select aria-label="已补货物品" value={all ? "" : product?.id ?? ""} onChange={event=>{setSelectedId(event.target.value);setChecked(false);}}>
      {products.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
      <option value="">全部物品</option>
    </select></label>
    {all ? <ul className="operator-stock-targets">{products.map(p=><li key={p.id}>{p.name}：当前剩余 {p.availableCount} 份 · 补满后 {p.initialStock} 份</li>)}</ul>
      : product&&<p>当前剩余 {product.availableCount} 份 · 补满后 {product.initialStock} 份</p>}
    <p>补货只更新数量，不结束原任务，也不解除新任务限制。</p>
    <label className="check-label"><input type="checkbox" checked={checked} onChange={event=>setChecked(event.target.checked)}/>{all ? "已核对并补满全部物品" : "已核对并补满所选物品"}</label>
    <button className="primary-button" disabled={disabled||!checked||!product} onClick={async()=>{
      if(product&&await onReset(all ? null : product.id))setChecked(false);
    }}>{all ? "重置全部物品库存" : "重置所选物品库存"}</button>
  </section>;
}
