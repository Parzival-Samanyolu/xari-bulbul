import type { Message } from '@harness/core/i18n'
import type en from '../en/common'

export default {
  'common.save': 'Kaydet',
  'common.cancel': 'İptal',
  'common.delete': 'Sil',
  'common.remove': 'Kaldır',
  'common.close': 'Kapat',
  'common.open': 'Aç',
  'common.add': 'Ekle',
  'common.edit': 'Düzenle',
  'common.copy': 'Kopyala',
  'common.copied': 'Kopyalandı',
  'common.retry': 'Yeniden dene',
  'common.stop': 'Durdur',
  'common.allow': 'İzin ver',
  'common.deny': 'Reddet',
  'common.back': 'Geri',
  'common.done': 'Tamam',
  'common.reset': 'Sıfırla',
  'common.show': 'Göster',
  'common.hide': 'Gizle',
  'common.loading': 'Yükleniyor…',
  'common.on': 'Açık',
  'common.off': 'Kapalı',
  'common.none': 'Yok',
  'common.default': 'Varsayılan',
} satisfies Record<keyof typeof en, Message>
