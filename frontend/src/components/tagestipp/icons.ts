/**
 * 60 decorative badge icons for Tagestipp (viewBox 0 0 16 16).
 * 1–20: abstract geometric; 21–60: minimalistic (half sun, flower, star, leaf, etc.).
 * Stroke/fill white.
 */
export type TagestippIconId =
  | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10'
  | '11' | '12' | '13' | '14' | '15' | '16' | '17' | '18' | '19' | '20'
  | '21' | '22' | '23' | '24' | '25' | '26' | '27' | '28' | '29' | '30'
  | '31' | '32' | '33' | '34' | '35' | '36' | '37' | '38' | '39' | '40'
  | '41' | '42' | '43' | '44' | '45' | '46' | '47' | '48' | '49' | '50'
  | '51' | '52' | '53' | '54' | '55' | '56' | '57' | '58' | '59' | '60'
  | 'default';

export interface IconDef {
  paths: { d: string; fill?: 'none' | 'white'; stroke?: 'white' }[];
}

const icons: Record<TagestippIconId, IconDef> = {
  default: {
    paths: [{ d: 'M8 2v4M3 4l3 3M13 4l-3 3M2 8h4M10 8h4', fill: 'none', stroke: 'white' }],
  },
  '1': {
    paths: [{ d: 'M8 2v4M3 4l3 3M13 4l-3 3M2 8h4M10 8h4', fill: 'none', stroke: 'white' }],
  },
  '2': {
    paths: [{ d: 'M8 3a5 5 0 1 1 0 10 5 5 0 0 1 0-10z', fill: 'none', stroke: 'white' }],
  },
  '3': {
    paths: [{ d: 'M3 3h10v10H3z', fill: 'none', stroke: 'white' }],
  },
  '4': {
    paths: [{ d: 'M8 2l6 6-6 6-6-6 6-6z', fill: 'none', stroke: 'white' }],
  },
  '5': {
    paths: [{ d: 'M8 2l6 12H2L8 2z', fill: 'none', stroke: 'white' }],
  },
  '6': {
    paths: [
      { d: 'M2 5h12', fill: 'none', stroke: 'white' },
      { d: 'M2 11h12', fill: 'none', stroke: 'white' },
    ],
  },
  '7': {
    paths: [
      { d: 'M5 2v12', fill: 'none', stroke: 'white' },
      { d: 'M11 2v12', fill: 'none', stroke: 'white' },
    ],
  },
  '8': {
    paths: [{ d: 'M8 8m-2 0a2 2 0 1 1 4 0 2 2 0 0 1-4 0', fill: 'white', stroke: 'white' }],
  },
  '9': {
    paths: [
      { d: 'M4 4m-1.5 0a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0', fill: 'white', stroke: 'white' },
      { d: 'M12 4m-1.5 0a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0', fill: 'white', stroke: 'white' },
      { d: 'M4 12m-1.5 0a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0', fill: 'white', stroke: 'white' },
      { d: 'M12 12m-1.5 0a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0', fill: 'white', stroke: 'white' },
    ],
  },
  '10': {
    paths: [
      { d: 'M5 2v6M5 8v6', fill: 'none', stroke: 'white' },
      { d: 'M2 5h6M8 5h6', fill: 'none', stroke: 'white' },
      { d: 'M2 11h6M8 11h6', fill: 'none', stroke: 'white' },
      { d: 'M11 2v6M11 8v6', fill: 'none', stroke: 'white' },
    ],
  },
  '11': {
    paths: [{ d: 'M4 4 Q8 4 8 8 Q8 12 4 12', fill: 'none', stroke: 'white' }],
  },
  '12': {
    paths: [
      { d: 'M5 3v10', fill: 'none', stroke: 'white' },
      { d: 'M11 3v10', fill: 'none', stroke: 'white' },
    ],
  },
  '13': {
    paths: [
      { d: 'M4 4l8 8', fill: 'none', stroke: 'white' },
      { d: 'M12 4l-8 8', fill: 'none', stroke: 'white' },
    ],
  },
  '14': {
    paths: [{ d: 'M4 12l4-8 4 8', fill: 'none', stroke: 'white' }],
  },
  '15': {
    paths: [
      { d: 'M6 3h2v10H6z', fill: 'none', stroke: 'white' },
      { d: 'M8 3h2v10H8z', fill: 'none', stroke: 'white' },
    ],
  },
  '16': {
    paths: [{ d: 'M4 8c0-2 2-4 4-4s4 2 4 4-2 4-4 4-4-2-4-4', fill: 'none', stroke: 'white' }],
  },
  '17': {
    paths: [{ d: 'M8 2l5 4v4l-5 4-5-4V6l5-4z', fill: 'none', stroke: 'white' }],
  },
  '18': {
    paths: [
      { d: 'M8 2v4M3 4l3 3M13 4l-3 3M2 8h4M10 8h4', fill: 'none', stroke: 'white' },
      { d: 'M8 6m-1 0a1 1 0 1 1 2 0 1 1 0 0 1-2 0', fill: 'white', stroke: 'white' },
    ],
  },
  '19': {
    paths: [
      { d: 'M8 8m-4 0a4 4 0 1 1 8 0 4 4 0 0 1-8 0', fill: 'none', stroke: 'white' },
      { d: 'M8 8m-2 0a2 2 0 1 1 4 0 2 2 0 0 1-4 0', fill: 'none', stroke: 'white' },
    ],
  },
  '20': {
    paths: [
      { d: 'M3 4l4 4-4 4', fill: 'none', stroke: 'white' },
      { d: 'M9 4l4 4-4 4', fill: 'none', stroke: 'white' },
    ],
  },
  // 21–60: minimalistic (half sun, flower, star, leaf, moon, etc.)
  '21': { paths: [{ d: 'M8 2a6 6 0 0 1 0 12M8 4a4 4 0 0 1 0 8', fill: 'none', stroke: 'white' }] },
  '22': { paths: [{ d: 'M8 2v2M8 12v2M4 4l1.5 1.5M10.5 10.5L12 12M2 8h2M12 8h2M4 12l1.5-1.5M10.5 5.5L12 4', fill: 'none', stroke: 'white' }] },
  '23': { paths: [{ d: 'M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5L8 2z', fill: 'none', stroke: 'white' }] },
  '24': { paths: [{ d: 'M8 3v2M8 11v2M6 5l-2 2 2 2M10 5l2 2-2 2M5 6h2l2 2 2-2h2', fill: 'none', stroke: 'white' }] },
  '25': { paths: [{ d: 'M8 2c-2 2-4 4-4 6s2 4 4 4 4-2 4-4-2-4-4-6', fill: 'none', stroke: 'white' }] },
  '26': { paths: [{ d: 'M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8z', fill: 'none', stroke: 'white' }, { d: 'M8 2v2M8 12v2M2 8h2M12 8h2M4 4l1.5 1.5M10.5 10.5L12 12M4 12l1.5-1.5M10.5 5.5L12 4', fill: 'none', stroke: 'white' }] },
  '27': { paths: [{ d: 'M8 2l1 5 5 1-5 1-1 5-1-5-5-1 5-1 1-5z', fill: 'none', stroke: 'white' }] },
  '28': { paths: [{ d: 'M8 4l-3 4h2v4h2V8h2L8 4z', fill: 'none', stroke: 'white' }] },
  '29': { paths: [{ d: 'M8 2Q4 6 8 8Q12 6 8 2', fill: 'none', stroke: 'white' }, { d: 'M8 8v6', fill: 'none', stroke: 'white' }] },
  '30': { paths: [{ d: 'M8 2a6 6 0 0 1 6 6c0 3-2 5-6 6-4-1-6-3-6-6a6 6 0 0 1 6-6z', fill: 'none', stroke: 'white' }] },
  '31': { paths: [{ d: 'M8 3c-2.5 1-4 3.5-4 5s1.5 4 4 5 4-2 4-5-1.5-4-4-5z', fill: 'none', stroke: 'white' }] },
  '32': { paths: [{ d: 'M8 2l2 4 4 1-3 3 1 4-4-2-4 2 1-4-3 3-4 2z', fill: 'none', stroke: 'white' }] },
  '33': { paths: [{ d: 'M8 1v4M8 11v4M1 8h4M11 8h4M3 3l3 3M10 10l3 3M3 13l3-3M10 6l3-3', fill: 'none', stroke: 'white' }] },
  '34': { paths: [{ d: 'M8 4c-2 0-4 1.5-4 4s2 4 4 4 4-1.5 4-4-2-4-4-4z', fill: 'none', stroke: 'white' }] },
  '35': { paths: [{ d: 'M8 2l1.5 4.5H14l-3.5 2.5 1.5 4.5L8 10l-4 3 1.5-4.5L2 6.5h4.5L8 2z', fill: 'none', stroke: 'white' }] },
  '36': { paths: [{ d: 'M8 3v3M5 6h6M8 9v4M8 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', fill: 'none', stroke: 'white' }] },
  '37': { paths: [{ d: 'M4 8c0-2 2-3 4-3s4 1 4 3-2 3-4 3-4-1-4-3z', fill: 'none', stroke: 'white' }] },
  '38': { paths: [{ d: 'M8 2v12M2 8h12', fill: 'none', stroke: 'white' }, { d: 'M5 5h6v6H5z', fill: 'none', stroke: 'white' }] },
  '39': { paths: [{ d: 'M8 4a2 2 0 0 1 2 2v4a2 2 0 0 1-4 0V6a2 2 0 0 1 2-2z', fill: 'none', stroke: 'white' }] },
  '40': { paths: [{ d: 'M8 2c-3 0-6 2-6 6s3 6 6 6 6-2 6-6-3-6-6-6z', fill: 'none', stroke: 'white' }] },
  '41': { paths: [{ d: 'M8 3L5 7h2v6h2V7h2L8 3z', fill: 'none', stroke: 'white' }] },
  '42': { paths: [{ d: 'M8 2l.5 2 2 .5-2 .5-.5 2-.5-2-2-.5 2-.5.5-2z', fill: 'none', stroke: 'white' }] },
  '43': { paths: [{ d: 'M4 8h8M8 4v8M6 6l2 2 2-2', fill: 'none', stroke: 'white' }] },
  '44': { paths: [{ d: 'M8 2a4 4 0 0 1 4 4c0 2-1.5 3.5-4 4-2.5-.5-4-2-4-4a4 4 0 0 1 4-4z', fill: 'none', stroke: 'white' }] },
  '45': { paths: [{ d: 'M8 1l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3z', fill: 'none', stroke: 'white' }] },
  '46': { paths: [{ d: 'M8 4l-4 4 4 4 4-4-4-4z', fill: 'none', stroke: 'white' }] },
  '47': { paths: [{ d: 'M8 2v4l3 3', fill: 'none', stroke: 'white' }, { d: 'M8 8m-2 0a2 2 0 1 1 4 0 2 2 0 0 1-4 0', fill: 'none', stroke: 'white' }] },
  '48': { paths: [{ d: 'M4 4h8v8H4zM6 6v4h4V6H6z', fill: 'none', stroke: 'white' }] },
  '49': { paths: [{ d: 'M8 2c-1 2-2 4-2 6s1 4 2 6c1-2 2-4 2-6s-1-4-2-6z', fill: 'none', stroke: 'white' }] },
  '50': { paths: [{ d: 'M8 3a5 5 0 0 1 5 5 5 5 0 0 1-5 5 5 5 0 0 1-5-5 5 5 0 0 1 5-5z', fill: 'none', stroke: 'white' }] },
  '51': { paths: [{ d: 'M8 4l2 2-2 2-2-2 2-2z', fill: 'none', stroke: 'white' }] },
  '52': { paths: [{ d: 'M2 8h4l2-4 2 4h4', fill: 'none', stroke: 'white' }] },
  '53': { paths: [{ d: 'M8 2l2 4h4l-3 2.5 1 4-4-2.5-4 2.5 1-4-3-2.5h4L8 2z', fill: 'none', stroke: 'white' }] },
  '54': { paths: [{ d: 'M8 4a4 4 0 0 1 4 4 4 4 0 0 1-4 4 4 4 0 0 1-4-4 4 4 0 0 1 4-4z', fill: 'none', stroke: 'white' }] },
  '55': { paths: [{ d: 'M8 2v12M4 6h8M4 10h8', fill: 'none', stroke: 'white' }] },
  '56': { paths: [{ d: 'M8 3L5 8h2v5h2V8h2L8 3z', fill: 'none', stroke: 'white' }] },
  '57': { paths: [{ d: 'M8 2a3 3 0 0 1 3 3 3 3 0 0 1-3 3 3 3 0 0 1-3-3 3 3 0 0 1 3-3z', fill: 'none', stroke: 'white' }] },
  '58': { paths: [{ d: 'M4 8l4-4 4 4-4 4-4-4z', fill: 'none', stroke: 'white' }] },
  '59': { paths: [{ d: 'M8 2c-2 1-3 3-3 5s1 4 3 5c2-1 3-3 3-5s-1-4-3-5z', fill: 'none', stroke: 'white' }] },
  '60': { paths: [{ d: 'M8 1v3M8 12v3M1 8h3M12 8h3M4 4l2 2M10 10l2 2M4 12l2-2M10 6l2-2', fill: 'none', stroke: 'white' }] },
};

export const TAGESTIPP_ICON_IDS: TagestippIconId[] = [
  'default', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10',
  '11', '12', '13', '14', '15', '16', '17', '18', '19', '20',
  '21', '22', '23', '24', '25', '26', '27', '28', '29', '30',
  '31', '32', '33', '34', '35', '36', '37', '38', '39', '40',
  '41', '42', '43', '44', '45', '46', '47', '48', '49', '50',
  '51', '52', '53', '54', '55', '56', '57', '58', '59', '60',
];

export function getTagestippIcon(id: TagestippIconId): IconDef {
  return icons[id] ?? icons.default;
}
