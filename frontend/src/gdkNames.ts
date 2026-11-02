// GDK 接口 → 观众能看懂的中文能力名（大屏不显示英文函数名；原始接口名仍保留在数据里）
const GDK_ZH: Record<string, string> = {
  'Pnc.normal_navi': '底盘导航',
  'Pnc.high_precision_navi': '高精度停靠',
  'Pnc.get_task_state': '导航状态反馈',
  'Pnc.relative_move': '底盘微调横移',
  'Pnc.cancel_task': '停止导航',
  'Camera.get_latest_image': '头部相机取图',
  'Camera.get_nearest_image': '深度图对齐',
  'Camera.get_camera_intrinsic': '相机内参',
  'TF.get_all_tf_from_base_link': '坐标变换',
  'Robot.joint_control_request': '头部与腰部转动',
  'Robot.end_effector_pose_control': '手臂末端控制',
  'Robot.move_ee_pos': '夹爪开合',
  'Robot.get_end_state': '夹爪力反馈',
}

export function gdkLabel(name: string): string {
  if (GDK_ZH[name]) return GDK_ZH[name]
  // 未收录的英文接口名不直接显示
  return /^[A-Za-z_.]+$/.test(name) ? '机器人接口' : name
}

/** 一组接口 → 去重后的中文能力名 */
export function gdkLabels(names: string[] = []): string[] {
  return [...new Set(names.map(gdkLabel))]
}
