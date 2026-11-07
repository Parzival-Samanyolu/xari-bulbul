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
| lobby | qrup söhbəti | grup sohbeti | групповой чат | A chat where several bots talk with you and each other. Use the group-chat wording in labels and hints too: "New lobby" is *Yeni qrup söhbəti* / *Yeni grup sohbeti* / *Новый групповой чат*. Do not transliterate (*lobbi*, *lobi*, *лобби*). |
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
| mode: Full auto | Tam avtomatik | Tam otomatik | Полностью автоматически | Never asks. Deny rules still apply. |
| settings | Ayarlar | Ayarlar | Настройки | |
| general | Ümumi | Genel | Общие | Settings page. |
| advanced | Qabaqcıl | Gelişmiş | Дополнительно | Settings page. Not az *Əlavə*, which reads as "appendix". |
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
| compact (context) | sıxlaşdır | sıkıştır | сжать | Summarising earlier messages to free context. az uses *sıxlaşdır* / *sıxlaşdırma* only, never *sıxışdır*. Nouns: *sıxlaşdırma* / *sıkıştırma* / *сжатие* ("Auto-compact": *Avtomatik sıxlaşdırma* / *Otomatik sıkıştırma* / *Автосжатие*). |
| thinking / reasoning | düşünmə | düşünme | рассуждение | The model's reasoning. "Thinking…": *Düşünür…* / *Düşünüyor…* / *Думает…*. |
| usage | istifadə | kullanım | расход | Tokens and cost. |
| cost | xərc | maliyet | стоимость | |
| budget | büdcə | bütçe | бюджет | Spending limit. |
| voice | səs | ses | голос | |
| read aloud | səsli oxu | sesli oku | прочитать вслух | Button on a reply. |
| hands-free | əllər sərbəst | eller serbest | без рук | Voice mode that listens and replies on its own. ru: *режим «без рук»*. |
| transcription | mətnə çevirmə | yazıya dökme | расшифровка | Speech to text. "Transcribing…": *Mətnə çevrilir…* / *Yazıya dökülüyor…* / *Расшифровка…*. |
| gateway | kanal | kanal | канал | One way to reach the agent from another app, such as iMessage or WhatsApp ("the WhatsApp channel"). The Settings page that groups them is *Messencerlər* / *Mesajlaşma uygulamaları* / *Мессенджеры*. Never translate it literally (*şlüz*, *ağ geçidi*, *шлюз*, *мост*). |
| terminal | terminal | terminal | терминал | |
| update | yeniləmə | güncelleme | обновление | App update. "Download update": *Yeniləməni endir* / *Güncellemeyi indir* / *Скачать обновление*. |
| stop | dayandır | durdur | остановить | Stops a running turn. |
| cancel | ləğv et | iptal | отмена | Closes a dialog without changes. |
| save | saxla | kaydet | сохранить | |
| delete | sil | sil | удалить | |
| retry | yenidən cəhd et | yeniden dene | повторить | |
| summary | xülasə | özet | сводка | What compaction leaves in place of older messages. ru: *заменены сводкой*; not *пересказ*. |
| permission mode | icazə rejimi | izin modu | режим разрешений | The Ask / Auto-edit / Plan / Full auto switch. Onboarding uses the same four names. |
| thinking level | düşünmə səviyyəsi | düşünme düzeyi | уровень рассуждения | The reasoning-effort setting. The chip reads *Düşünmə: {level}* / *Düşünme: {level}* / *Рассуждение: {level}*. |
| effort: None / Low / Medium / High / Extra high / Max | Yoxdur / Aşağı / Orta / Yüksək / Çox yüksək / Maksimum | Yok / Düşük / Orta / Yüksek / Çok yüksek / Maksimum | Нет / Низкое / Среднее / Высокое / Очень высокое / Максимальное | ru agrees with the noun: neuter after *Рассуждение* (chat chip, bot editor), masculine (*Низкий* …) under *Уровень рассуждения* (Settings › Main model). |
| default (choice) | standart | varsayılan | по умолчанию | "Default model": *Standart model* / *Varsayılan model* / *Модель по умолчанию*. Not az *susmaya görə*. |
| speed: Standard / Fast / Batch | Standart / Sürətli / Paket | Standart / Hızlı / Toplu | Обычная / Быстрая / Пакетная | |
| theme | tema | tema | тема | Not az *mövzu*. |
| Mix (Mixture of Agents) | Qarışıq | Karışım | Смесь | The composer toggle; the Settings section is *Agentlər qarışığı* / *Ajan karışımı* / *Смесь агентов*. Cite the toggle by this exact name. |
| Abilities (bot editor) | Qabiliyyətlər | Yetenekler | Возможности | The bot editor section. az avoids *bacarıq*, which is "skill". |
| slash command | slash əmri | eğik çizgi komutu | слэш-команда | `/name` commands from `.harness/commands`. |
| review (end of turn) | yoxlama | kontrol | проверка | The agent's check for unfinished steps before it stops. |
| request (status bar) | sorğu | istek | запрос | One model call. |
| cached (tokens) | keşdən | önbellekten | из кэша | |
| speech to text / text to speech (Settings sections) | Nitqdən mətnə / Mətndən nitqə | Konuşmadan metne / Metinden konuşmaya | Распознавание речи / Озвучивание текста | Cite them as Settings › Agent › … . |
| tab (sidebar) | bölmə | sekme | вкладка | The Sessions and Bots tabs: *Söhbətlər*, *Botlar* / *Sohbetler*, *Botlar* / *«Чаты»*, *«Боты»*. |
| Settings path | Ayarlar › … | Ayarlar › … | Настройки › … | Use the real tab and section titles, joined by ›. az adds *bölməsində*, tr *bölümünde*, ru *в разделе*. |
| copy / copied | kopyala / kopyalandı | kopyala / kopyalandı | копировать / скопировано | |
