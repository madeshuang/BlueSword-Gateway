// 线性图标（1.6 描边），风格统一，不引第三方图标库
type P = { size?: number }
const base = (size = 20) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
})

export const IconChat = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z" />
    <path d="M8.5 8.5h7M8.5 11.5h4" />
  </svg>
)
export const IconEye = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7S2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)
export const IconRoute = ({ size }: P) => (
  <svg {...base(size)}>
    <circle cx="6" cy="18" r="2.2" />
    <circle cx="18" cy="6" r="2.2" />
    <path d="M8.2 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.8" />
  </svg>
)
export const IconHand = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M7 11V6.5a1.5 1.5 0 0 1 3 0V11M10 10V4.5a1.5 1.5 0 0 1 3 0V10M13 10V5.5a1.5 1.5 0 0 1 3 0V12M16 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1a6 6 0 0 1-4.6-2.2L3.6 15a1.5 1.5 0 0 1 2.3-1.9L7 14.5" />
  </svg>
)
export const IconPlus = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)
export const IconSend = ({ size }: P) => (
  <svg {...base(size)} strokeWidth={2}>
    <path d="M5 12h13M13 6l6 6-6 6" />
  </svg>
)
export const IconMic = ({ size }: P) => (
  <svg {...base(size)}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
  </svg>
)
export const IconRobot = ({ size }: P) => (
  <svg {...base(size)}>
    <rect x="5" y="8" width="14" height="11" rx="4" />
    <path d="M12 8V4.5M9.5 13v1.5M14.5 13v1.5" />
    <circle cx="12" cy="3.5" r="1" />
  </svg>
)
export const IconSpark = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
  </svg>
)
export const IconCheck = ({ size }: P) => (
  <svg {...base(size)} strokeWidth={2.2}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
)
