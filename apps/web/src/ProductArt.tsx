import type { BoothProduct } from "@bluesword/contracts";
import { Flame, Club, PenLine, CupSoda, CircleDot, Feather, Wind, Cookie, Milk, CakeSlice, Popcorn } from "lucide-react";
const siteIcons = { lighter_box: Flame, playing_card_box: Club, pen_box: PenLine, bottle: CupSoda,
  table_tennis_ball_box: CircleDot, shuttlecock_tube: Feather, air_pump: Wind, aoliao: Cookie,
  anmuxi: Milk, haoliyou: CakeSlice, shupian: Popcorn };
export function ProductArt({product,small=false}:{product:BoothProduct;small?:boolean}) {
  if(product.imageUrl)return <img className="product-image" src={product.imageUrl} alt={product.name}/>;
  if (Object.hasOwn(siteIcons, product.art)) {
    const Icon = siteIcons[product.art as keyof typeof siteIcons];
    return <svg viewBox="0 0 260 220" className="product-art" aria-hidden="true">
      <ellipse cx="130" cy="188" rx="68" ry="12" fill="#244b57" opacity=".12"/>
      <rect x="62" y="32" width="136" height="146" rx="24" fill="#fff" opacity=".85"/>
      <Icon x="85" y="58" width="90" height="90" color="#244b57" strokeWidth="1.5"/>
    </svg>;
  }
  const id="art-"+product.id+(small?"-small":"-large");
  return <svg viewBox="0 0 260 220" className="product-art" aria-hidden="true"><defs>
    <linearGradient id={id+"-glass"}><stop stopColor="#fff"/><stop offset=".5" stopColor="#eaf4f5"/><stop offset="1" stopColor="#b1ccd5"/></linearGradient>
    <linearGradient id={id+"-paper"} x2="1" y2="1"><stop stopColor="#fbefdc"/><stop offset="1" stopColor="#cdb18c"/></linearGradient>
    <linearGradient id={id+"-box"} x2="1" y2="1"><stop stopColor="#fff"/><stop offset="1" stopColor="#c9cde0"/></linearGradient>
    <radialGradient id={id+"-shadow"}><stop stopColor="#213d35" stopOpacity=".2"/><stop offset="1" stopColor="#213d35" stopOpacity="0"/></radialGradient>
  </defs><ellipse cx="133" cy="193" rx="80" ry="17" fill={"url(#"+id+"-shadow)"}/>
  {product.art==="water"&&<g transform="rotate(-9 130 110)"><path d="M111 46h38v22c0 12 19 19 19 36v69c0 12-8 18-38 18s-38-6-38-18v-69c0-17 19-24 19-36Z" fill={"url(#"+id+"-glass)"} stroke="#b5cfd6"/><path d="M97 102h66v18H97zm-1 57h68v6H96zm0 13h68v5H96" fill="#a9c8d1" opacity=".36"/><rect x="106" y="32" width="48" height="22" rx="5" fill="#203f4b"/><path d="M113 37v12m7-12v12m7-12v12m7-12v12m7-12v12m7-12v12" stroke="#477281"/><rect x="92" y="116" width="76" height="41" rx="2" fill="#244b57"/><text x="130" y="135" textAnchor="middle" fill="#fafbf7" fontSize="9" letterSpacing="2">PURE WATER</text><path d="M120 144h20" stroke="#d0b881"/><path d="M109 75c-10 14-12 18-12 28" stroke="#fff" strokeWidth="5" strokeLinecap="round" opacity=".85"/></g>}
  {product.art==="snack"&&<g transform="rotate(-6 130 110)"><path d="M62 76 77 57h111l13 19-8 90-12 19H80l-15-19Z" fill={"url(#"+id+"-paper)"} stroke="#cbb292"/><path d="M77 57v18h111V57M78 174h104v11" stroke="#ae9576" fill="none" strokeWidth="2"/><path d="M75 81h115v80H75Z" fill="#fff9ee" opacity=".8"/><path d="M86 124c0-24 17-35 44-35 30 0 47 12 47 34 0 17-15 27-45 27s-46-9-46-26Z" fill="#b47d45"/><path d="M88 118c0-18 16-29 43-29s45 11 45 29c-13 12-67 13-88 0" fill="#ddb072"/><path d="m112 93-10 23m28-26-11 29m28-24-11 22m28-19-8 17" stroke="#af733e" strokeWidth="3" strokeLinecap="round"/><text x="132" y="166" textAnchor="middle" fill="#71543e" fontSize="8" letterSpacing="3">A LITTLE ENERGY</text></g>}
  {product.art==="gift"&&<g transform="rotate(7 130 110)"><path d="m58 99 69-28 75 28-69 31Z" fill="#f3f2fa"/><path d="M58 99v64l75 33v-66Z" fill={"url(#"+id+"-box)"}/><path d="m133 130 69-31v66l-69 31Z" fill="#bbc0d5"/><path d="m86 86 75 30v66l-21 9v-66l-75-30Z" fill="#3d4b6a"/><path d="m177 88-69 30v67l-17-7v-66l69-30Z" fill="#516583"/><path d="M129 96c-41-5-46-30-27-31 22-1 24 15 27 31Zm1 0c43-7 48-31 29-32-21-2-29 20-29 32Z" fill="none" stroke="#425371" strokeWidth="9"/><path d="m121 91 21 7" stroke="#acb3cb" strokeWidth="6"/><text x="177" y="153" transform="rotate(-23 177 153)" textAnchor="middle" fontSize="8" fill="#f7f7fb" letterSpacing="2">WITH YOU</text></g>}
  {product.art==="greens"&&<g><path d="M83 112c-21-37-8-58 13-21-3-39 16-43 20-4 9-48 27-44 20-5 27-35 45-17 18 12 38-14 48 10 15 23" fill="#718d53"/><path d="M116 116c-42-22-43-47-18-43 25 5 23 24 18 43Z" fill="#93a66f"/><path d="M127 116c-15-51 8-67 20-48 11 23-8 43-20 48Z" fill="#537c4a"/><path d="M140 121c12-41 47-49 47-27 0 14-23 31-47 27Z" fill="#88a562"/><path d="M67 108h126l-13 76H81Z" fill={"url(#"+id+"-paper)"}/><path d="m67 108 14 16h99l13-16" fill="#e9dbc4"/><path d="M100 119V96c0-34 62-34 62 0v23" fill="none" stroke="#af9c7e" strokeWidth="7"/><rect x="109" y="138" width="45" height="31" rx="1" fill="#f9f5e9"/><path d="M128 159c-9-5-12-14-6-16 8 1 8 7 6 16Zm1 0c-1-12 11-17 13-11-1 7-8 10-13 11Z" fill="#657f51"/></g>}
  </svg>;
}
