import { useState } from "react";
import {
  ArrowRight,
  Check,
  Minus,
  Plus,
  X,
} from "lucide-react";
import type { BoothController } from "../useBooth";
import { Modal } from "./Modal";

import { ProductSymbol } from "./ProductSymbol";
export { ProductSymbol } from "./ProductSymbol";

export function CatalogDialog({
  booth: c,
  onClose,
  onConfirm,
}: {
  booth: BoothController;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [category, setCategory] = useState("全部");
  const products = c.state!.products;
  return (
    <Modal title="选一份喜欢的物品" onClose={onClose} wide className="catalog-modal">
      <p className="modal-description">
        也可以直接告诉我你的需求。每单最多选择两件。
      </p>
      <div className="catalog-categories" aria-label="物品分类">
        {["全部", ...new Set(products.map((p) => p.category))].map((name) => (
          <button
            key={name}
            aria-pressed={name === category}
            onClick={() => setCategory(name)}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="catalog-grid">
        {products
          .filter((p) => category === "全部" || p.category === category)
          .map((product) => {
            const chosen = c.selectedItems.find(
              (item) => item.productId === product.id,
            );
            return (
              <button
                className={`catalog-product${chosen ? " selected" : ""}`}
                key={product.id}
                aria-label={`选择${product.name}`}
                aria-pressed={!!chosen}
                disabled={
                  c.busy ||
                  !!c.pending ||
                  product.availableCount === 0 ||
                  (!chosen && c.total >= 2)
                }
                onClick={() =>
                  chosen ? c.removeItem(product.id) : c.choose(product)
                }
              >
                <ProductSymbol product={product} />
                <span className="catalog-product-copy"><strong>{product.name}</strong>
                <small>
                  {product.availableCount === 0
                    ? "暂时取完"
                    : `可取 ${product.availableCount} 件`}
                </small></span>
                {chosen && <Check size={15} className="product-check" />}
              </button>
            );
          })}
      </div>
      <footer className="modal-actions catalog-actions">
        <span className="selection-count">已选 {c.total} / 2 件</span>
        <button className="secondary-button" onClick={onClose}>
          稍后再选
        </button>
        <button
          className="primary-button"
          disabled={c.total === 0 || c.invalidSelection}
          onClick={onConfirm}
        >
          核对选择
          <ArrowRight size={16} />
        </button>
      </footer>
    </Modal>
  );
}

export function OrderDialog({
  booth: c,
  onClose,
  onCatalog,
}: {
  booth: BoothController;
  onClose: () => void;
  onCatalog: () => void;
}) {
  const problem = c.pending ? null : c.selectionError;
  const blocked = !c.pending && (c.blocked || !c.state!.dispatch.ready);
  return (
    <Modal title="确认这份取物清单" onClose={onClose}>
      <p className="modal-description">
        请核对物品与数量，确认后才会提交给机器人。
      </p>
      <div className="confirmation-items">
        {c.selectedItems.map((item) => {
          const product = c.state!.products.find(
            (p) => p.id === item.productId,
          );
          return (
            <div className="confirmation-row" key={item.productId}>
              <ProductSymbol
                product={product ?? { id: item.productId, color: "#eaf4f5" }}
              />
              <div className="confirmation-product">
                <strong>{product?.name ?? item.productId}</strong>
                <small>{product?.category ?? "目录已更新"}</small>
              </div>
              <div className="quantity-control">
                <button
                  aria-label={`减少${product?.name}数量`}
                  disabled={c.busy || !!c.pending || item.count <= 1}
                  onClick={() => c.changeCount(item.productId, item.count - 1)}
                >
                  <Minus size={14} />
                </button>
                <output aria-label={`${product?.name}数量`}>
                  {item.count}
                </output>
                <button
                  aria-label={`增加${product?.name}数量`}
                  disabled={
                    c.busy ||
                    !!c.pending ||
                    c.total >= 2 ||
                    !product ||
                    item.count >=
                      Math.min(product.maxCount, product.availableCount)
                  }
                  onClick={() => c.changeCount(item.productId, item.count + 1)}
                >
                  <Plus size={14} />
                </button>
              </div>
              <button
                className="icon-button remove-item"
                aria-label={`移除${product?.name}`}
                disabled={c.busy || !!c.pending}
                onClick={() => c.removeItem(item.productId)}
              >
                <X size={15} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="confirmation-total">
        <span>取物数量</span>
        <strong>共 {c.total} 件</strong>
      </div>
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
      {blocked && (
        <p role="status" className="form-error">
          {c.state!.active || c.state!.alert
            ? "当前任务尚未结束，请先查看进度或联系工作人员。"
            : c.state!.dispatch.reason}
        </p>
      )}
      {!c.connected && (
        <p role="status" className="form-error">
          连接暂时中断，请等待状态恢复后确认。
        </p>
      )}
      {c.error && (
        <p role="alert" className="form-error">
          {c.error}
        </p>
      )}
      <div className="assistant-note">
        {c.pending
          ? "正在核对同一次取物请求。请勿另建请求重复取物。"
          : "确认后请在展台等候，取物进度会在对话中更新。"}
      </div>
      <footer className="modal-actions">
        <button
          className="secondary-button"
          disabled={c.busy || !!c.pending}
          onClick={onCatalog}
        >
          换一换
        </button>
        <button className="text-button" onClick={onClose}>
          {c.pending ? "回到对话" : "暂不取物"}
        </button>
        <button
          className="primary-button"
          disabled={c.busy || !c.connected || blocked || !!problem}
          onClick={() => void c.submit()}
        >
          {c.busy ? "正在确认…" : c.pending ? "核对这次取物" : "确认取物"}
          <ArrowRight size={16} />
        </button>
      </footer>
    </Modal>
  );
}
