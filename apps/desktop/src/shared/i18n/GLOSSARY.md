# Glossary

The chosen translation of each recurring term in the app. Use these every time, so a word means one thing everywhere. When a term is missing, add it here before using it.

## Style

- **Tone:** calm, precise, plain. Short sentences, no exclamation marks, no marketing words.
- **Address:** formal you. az *siz*, tr *siz*, ru *вы* (lowercase).
- **Buttons and menu items:**
  - az uses the imperative: *Saxla*, *Sil*, *Ləğv et*.
  - tr uses the imperative: *Kaydet*, *Sil*, *İptal*.
  - ru uses the infinitive: *Сохранить*, *Удалить*, *Отмена*.
- **Capitalisation:** sentence case in every language. Only the first word and proper names are capitalised.
- **Do not translate:**
  - the app name *Xarı Bülbül*
  - provider, model and product names: OpenRouter, Ollama, GitHub, WhatsApp, MCP
  - file paths, commands, setting ids, keyboard shortcuts
- **Quotation marks:** az and tr use “…”, ru uses «…».
- **Numbers after a count:**
  - In az and tr the noun stays singular (*5 fayl*, *5 dosya*), so `one` and `other` are often the same text.
  - ru needs `one` / `few` / `many` / `other`: *1 файл*, *2 файла*, *5 файлов*, *1,5 файла*.
- **Placeholders:** keep every `{name}` from the English message, unchanged. Moving them within the sentence is fine.

## Terms

| English | Azərbaycanca | Türkçe | Русский | Note |
|---|---|---|---|---|
| chat | söhbət | sohbet | чат | One thread in the sidebar. "New chat": *Yeni söhbət* / *Yeni sohbet* / *Новый чат*. |
| conversation | söhbət | konuşma | разговор | The messages within a chat. az has no separate word, so use *söhbət*. |
| message | mesaj | mesaj | сообщение | |
| reply | cavab | yanıt | ответ | The model's answer. Avoid tr *cevap* for consistency. |
| bot | bot | bot | бот | A companion persona in the Bots tab. |
| lobby | lobbi | lobi | лобби | A group chat of several bots. Explain it as a group chat in hints: *qrup söhbəti* / *grup sohbeti* / *групповой чат*. |
| agent | agent | ajan | агент | The assistant that runs tools. |
| subagent | köməkçi agent | yardımcı ajan | субагент | Started by the `task` tool. |
| model | model | model | модель | |
| local model | lokal model | yerel model | локальная модель | Runs on this computer. |
| free model | pulsuz model | ücretsiz model | бесплатная модель | |
| provider | provayder | sağlayıcı | провайдер | OpenRouter, Ollama Cloud and so on. |
| API key | API açarı | API anahtarı | API-ключ | |
| tool | alət | araç | инструмент | |
| tool call | alət çağırışı | araç çağrısı | вызов инструмента | |
| command | əmr | komut | команда | A shell command. |
| file | fayl | dosya | файл | |
| folder | qovluq | klasör | папка | Also used for "workspace" in the UI. Do not say "work area". |
| project | layihə | proje | проект | |
| changes | dəyişikliklər | değişiklikler | изменения | File edits made in a chat (the diff panel). |
| approval | təsdiq | onay | подтверждение | The request to allow a tool call. "Needs approval": *Təsdiq gözləyir* / *Onay bekliyor* / *Ждёт подтверждения*. |
| approve / allow | icazə ver | izin ver | разрешить | Button. "Allow once": *Bir dəfə icazə ver* / *Bir kez izin ver* / *Разрешить один раз*. "Always allow": *Həmişə icazə ver* / *Her zaman izin ver* / *Разрешать всегда*. |
| deny | rədd et | reddet | запретить | Button. |
| permission | icazə | izin | разрешение | Permission rules. |
| mode: Ask | Soruş | Sor | Спрашивать | Asks before edits and commands. |
| mode: Auto-edit | Avto-redaktə | Otomatik düzenleme | Автоправки | Edits files freely and asks before commands. |
| mode: Plan | Plan | Plan | План | Read-only: investigates and proposes a plan. |
| mode: Full auto | Tam avtomatik | Tam otomatik | Полный автомат | Never asks. Deny rules still apply. |
| settings | Ayarlar | Ayarlar | Настройки | |
| general | Ümumi | Genel | Общие | Settings page. |
| advanced | Əlavə | Gelişmiş | Дополнительно | Settings page. |
| safety | Təhlükəsizlik | Güvenlik | Безопасность | Settings page. |
| data | Məlumatlar | Veriler | Данные | Settings page. |
| logs | Qeydlər | Günlükler | Журналы | Settings page. |
| profile | Profil | Profil | Профиль | |
| system (option) | Sistem | Sistem | Системный / Системная | Follows the OS. In ru the adjective agrees with the noun: *Системный* (язык), *Системная* (тема). |
| memory | yaddaş | bellek | память | What the agent remembers between chats. "Remember": *yadda saxla* / *hatırla* / *запомнить*. |
| skill | bacarıq | beceri | навык | |
| plugin | plagin | eklenti | плагин | |
| extension | genişləndirmə | uzantı | расширение | Tools and commands from `.harness/`. |
| MCP server | MCP serveri | MCP sunucusu | MCP-сервер | |
| schedule | cədvəl | zamanlama | расписание | Scheduled runs. "Scheduled task": *planlaşdırılmış tapşırıq* / *zamanlanmış görev* / *задача по расписанию*. |
| task / to-do | tapşırıq | görev | задача | Items in the agent's to-do list. |
| session | sessiya | oturum | сеанс | Prefer "chat" in UI copy. Use this only where the code concept leaks, as in usage per session. |
| context | kontekst | bağlam | контекст | The model's context window. "Context is full": *Kontekst doludur* / *Bağlam dolu* / *Контекст заполнен*. |
| compact (context) | yığcamlaşdır | sıkıştır | сжать | Summarising earlier messages to free context. |
| thinking / reasoning | düşünmə | düşünme | рассуждение | The model's reasoning. "Thinking…": *Düşünür…* / *Düşünüyor…* / *Думает…*. |
| usage | istifadə | kullanım | расход | Tokens and cost. |
| cost | xərc | maliyet | стоимость | |
| budget | büdcə | bütçe | бюджет | Spending limit. |
| voice | səs | ses | голос | |
| read aloud | səsli oxu | sesli oku | прочитать вслух | Button on a reply. |
| hands-free | əllər sərbəst | eller serbest | без рук | Voice mode that listens and replies on its own. ru: *режим «без рук»*. |
| transcription | mətnə çevirmə | yazıya dökme | расшифровка | Speech to text. "Transcribing…": *Mətnə çevrilir…* / *Yazıya dökülüyor…* / *Расшифровка…*. |
| gateway | körpü | köprü | мост | Connection to WhatsApp, Telegram and similar services. |
| terminal | terminal | terminal | терминал | |
| update | yeniləmə | güncelleme | обновление | App update. "Download update": *Yeniləməni endir* / *Güncellemeyi indir* / *Скачать обновление*. |
| stop | dayandır | durdur | остановить | Stops a running turn. |
| cancel | ləğv et | iptal | отмена | Closes a dialog without changes. |
| save | saxla | kaydet | сохранить | |
| delete | sil | sil | удалить | |
| retry | yenidən cəhd et | yeniden dene | повторить | |
| copy / copied | kopyala / kopyalandı | kopyala / kopyalandı | копировать / скопировано | |
