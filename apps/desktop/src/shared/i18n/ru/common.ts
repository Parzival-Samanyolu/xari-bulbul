import type { Message } from '@harness/core/i18n'
import type en from '../en/common'

export default {
  'common.save': 'Сохранить',
  'common.cancel': 'Отмена',
  'common.delete': 'Удалить',
  'common.remove': 'Убрать',
  'common.close': 'Закрыть',
  'common.open': 'Открыть',
  'common.add': 'Добавить',
  'common.edit': 'Изменить',
  'common.copy': 'Копировать',
  'common.copied': 'Скопировано',
  'common.retry': 'Повторить',
  'common.stop': 'Остановить',
  'common.allow': 'Разрешить',
  'common.deny': 'Запретить',
  'common.back': 'Назад',
  'common.done': 'Готово',
  'common.reset': 'Сбросить',
  'common.loading': 'Загрузка…',
  'common.on': 'Вкл.',
  'common.off': 'Выкл.',
  'common.none': 'Нет',
  'common.default': 'По умолчанию',
} satisfies Record<keyof typeof en, Message>
