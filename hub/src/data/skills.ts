export type SkillGroup =
  | 'Addition'
  | 'Subtraction'
  | 'Number Bonds'
  | 'Missing Number'
  | 'Multiplication'
  | 'Division'

export interface Skill {
  position: number
  id: string
  label: string
  group: SkillGroup
}

export const SKILLS: Skill[] = [
  { position: 0, id: 'add5', label: 'Add within 5', group: 'Addition' },
  { position: 1, id: 'sub5', label: 'Subtract within 5', group: 'Subtraction' },
  { position: 2, id: 'add10', label: 'Add within 10', group: 'Addition' },
  { position: 3, id: 'sub10', label: 'Subtract within 10', group: 'Subtraction' },
  { position: 4, id: 'make10', label: 'Make 10 (number bonds)', group: 'Number Bonds' },
  { position: 5, id: 'add20', label: 'Add within 20', group: 'Addition' },
  { position: 6, id: 'sub20', label: 'Subtract within 20', group: 'Subtraction' },
  { position: 7, id: 'miss10', label: 'Missing number to 10', group: 'Missing Number' },
  { position: 8, id: 'miss20', label: 'Missing number to 20', group: 'Missing Number' },
  { position: 9, id: 'add2d', label: '2-digit + 1-digit', group: 'Addition' },
  { position: 10, id: 'sub2d', label: '2-digit − 1-digit', group: 'Subtraction' },
  { position: 11, id: 'add2d2d', label: '2-digit + 2-digit', group: 'Addition' },
  { position: 12, id: 'missBig', label: 'Missing number (bigger)', group: 'Missing Number' },
  { position: 13, id: 'mult2', label: 'Multiply by 2', group: 'Multiplication' },
  { position: 14, id: 'mult510', label: 'Multiply by 5 & 10', group: 'Multiplication' },
  { position: 15, id: 'multTo5', label: 'Times tables to 5', group: 'Multiplication' },
  { position: 16, id: 'multTo10', label: 'Times tables to 10', group: 'Multiplication' },
  { position: 17, id: 'multMiss', label: 'Missing factor (? × 5 = 20)', group: 'Missing Number' },
  { position: 18, id: 'mult2d', label: '2-digit × 1-digit', group: 'Multiplication' },
  { position: 19, id: 'div2510', label: 'Divide by 2, 5, 10', group: 'Division' },
  { position: 20, id: 'divTo10', label: 'Division facts', group: 'Division' },
  { position: 21, id: 'divMiss', label: 'Missing number (20 ÷ ? = 4)', group: 'Missing Number' },
  { position: 22, id: 'mixMD', label: 'Mixed × and ÷', group: 'Multiplication' },
]

export const SKILL_GROUPS: SkillGroup[] = [
  'Addition',
  'Subtraction',
  'Number Bonds',
  'Missing Number',
  'Multiplication',
  'Division',
]
