import { EDITION } from '../../../shared/edition'
import xariMark from '../assets/mark.png'
import qaqashMark from '../assets/mark-qaqash.png'

/** The app's picture for the loading, welcome and setup screens: Xarı's orchid, or Qaqaş's two chat bubbles. */
export const mark = EDITION.id === 'qaqash' ? qaqashMark : xariMark
