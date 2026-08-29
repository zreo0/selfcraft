/** BeUI 使用的快速减速曲线 */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/** BeUI 使用的自然往返曲线 */
export const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const;

/** BeUI 可点击控件按压时使用的弹簧参数 */
export const SPRING_PRESS = {
    type: 'spring',
    stiffness: 500,
    damping: 30,
    mass: 0.6,
} as const;

/** BeUI 图标和标签交换时使用的弹簧参数 */
export const SPRING_SWAP = {
    type: 'spring',
    stiffness: 460,
    damping: 30,
    mass: 0.55,
} as const;

/** BeUI 共享布局移动时使用的弹簧参数 */
export const SPRING_LAYOUT = {
    type: 'spring',
    stiffness: 360,
    damping: 32,
    mass: 0.6,
} as const;
