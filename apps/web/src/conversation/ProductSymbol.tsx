import type { ReactNode } from "react";
import type { BoothStockProduct } from "@bluesword/contracts";

// Match the catalog's explicit art key, rather than guessing from category names.
const artwork: Record<string, ReactNode> = {
  lighter_box: <><rect x="10" y="19" width="20" height="16" rx="4"/><path d="M10 20V9a3 3 0 0 1 3-3h14a3 3 0 0 1 3 3v7M15 14v5m10-5v5m-10-9h10M17 27h6"/><path d="m21 9-3 5h4l-3 5"/></>,
  playing_card_box: <><rect x="7" y="8" width="22" height="28" rx="3"/><path d="m16 8 13-4a3 3 0 0 1 4 2l5 21a3 3 0 0 1-2 4l-7 2"/><path d="m18 16 5 6-5 6-5-6Z"/><path d="M11 12h2m10 20h2"/></>,
  pen_box: <><path d="m11 29 15-21a3 3 0 0 1 5 4L16 33l-7 3Zm12-17 5 4M11 29l5 4M25 7l2-3m-7 9-7 10"/><path d="M22 36h12"/></>,
  table_tennis_ball_box: <><path d="M12 6c-8 3-8 12-3 18 4 5 10 5 15 0s7-12 2-16c-4-4-9-4-14-2Z"/><path d="m19 28 6 9 5-4-7-8M7 19l15-12"/><circle cx="32" cy="12" r="5"/></>,
  shuttlecock_tube: <><path d="m9 6 6 23h10l6-23-7 3-4-5-4 5Z"/><path d="m9 6 11 23L31 6M16 9l4 20 4-20M15 25h10M15 29v3a5 5 0 0 0 10 0v-3"/></>,
  air_pump: <><path d="M12 5h16M20 5v10M15 34V15h10v19M10 35h20M25 19h4c6 0 7 4 7 9v4h-4v-6M32 32v4"/><path d="M18 19v10"/></>,
  aoliao: <><ellipse cx="20" cy="15" rx="13" ry="10"/><path d="M7 15v10c0 6 26 6 26 0V15M7 20c0 6 26 6 26 0"/><ellipse cx="20" cy="15" rx="8" ry="6"/><path d="m17 15 3-3 3 3-3 3ZM10 13h1m18 0h1M16 8v1m8-1v1"/></>,
  anmuxi: <><path d="m13 5-4 7v23h23V12l-5-7ZM9 12h23M13 5v7M27 5v7M25 12v23"/><path d="M15 18h5M15 28h5"/><path d="M18 20s-3 3-3 5a3 3 0 0 0 6 0c0-2-3-5-3-5Z"/></>,
  haoliyou: <><ellipse cx="20" cy="12" rx="14" ry="7"/><path d="M6 12v16c0 10 28 10 28 0V12M6 19c5 5 8 1 12 4s11 1 16-4M6 25c5 5 9 1 13 4s10 0 15-4"/><path d="M13 11h2m5-3h2m4 5h2"/></>,
  shupian: <><path d="M9 5h22l-2 6 3 24H8l3-24ZM10 10h20M9 31h22"/><ellipse cx="18" cy="21" rx="5" ry="7" transform="rotate(-28 18 21)"/><path d="M23 15c9-1 8 11 2 12M15 17l5 8M12 5v3m4-3v3m4-3v3m4-3v3m4-3v3"/></>,
  water: <><path d="M16 5h8v7l5 6v16H11V18l5-6ZM16 9h8M11 21h18M11 28h18"/></>,
  bottle: <><path d="M13 6h14v5H13ZM12 11h16v24H12ZM16 16v13"/></>,
  snack: <><path d="M8 7h24l-2 7 2 21H8l2-21ZM8 11h24"/><circle cx="20" cy="23" r="7"/><path d="M17 20h1m5 3h1m-6 3h1"/></>,
  gift: <><rect x="6" y="15" width="28" height="7" rx="1"/><path d="M9 22v13h22V22M20 15v20M20 15C7 15 8 3 14 6c4 1 6 9 6 9Zm0 0c13 0 12-12 6-9-4 1-6 9-6 9Z"/></>,
  greens: <><path d="M8 19h24l-4 16H12ZM20 25V10M20 17C8 17 9 6 9 6s11-1 11 11Zm0 5c0-13 12-14 12-14s2 13-12 14Z"/></>,
};
const fallback = <><path d="m7 13 13-7 13 7v16l-13 7-13-7ZM7 13l13 7 13-7M20 20v16M14 9l13 7"/></>;
export function ProductSymbol({product}: {
  product: Pick<BoothStockProduct, "id" | "color"> & Partial<Pick<BoothStockProduct, "art">>;
}) {
  const key = product.art ?? product.id;
  return <span className="product-symbol" style={{backgroundColor: product.color}}>
    <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-product-art={key}>
      {artwork[key] ?? fallback}
    </svg>
  </span>;
}
