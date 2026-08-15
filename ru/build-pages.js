/* Generate the Russian prose pages from the English ones.
 *
 * Run: node ru/build-pages.js
 * Writes: ru/legal.html, ru/guide.html, ru/delete-account.html
 *
 * WHY GENERATE RATHER THAN COPY
 *
 * The chrome — the whole 120-line inline stylesheet, the font stack, the back
 * link, the footer — is identical on both languages and must stay identical.
 * Hand-maintaining a second copy means it drifts the first time someone tweaks
 * a colour, and nobody notices until a Russian reader sees a page from three
 * deploys ago. So the head and shell come from the English file every build,
 * and only the prose is authored here.
 *
 * The prose IS authored, not string-substituted. Russian nouns take a case
 * decided by the rest of the sentence, so a page reassembled from translated
 * fragments reads as machine output. Whole blocks are written in Russian
 * against the English meaning — that is the split i18n/FINDINGS.md argues for.
 *
 * Two head fixes are load-bearing, not cosmetic:
 *   - font URLs are relative in the English files; served from /ru/ they would
 *     resolve to /ru/fonts/… and 404, dropping the page to system fonts;
 *   - the Cyrillic faces have to be declared here too, or the Russian text has
 *     no glyphs to render with.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const CYRILLIC = `
/* Cyrillic. Latin pages never fetch these — unicode-range says so. */
@font-face{font-family:'Inter';font-style:normal;font-weight:400;font-display:swap;
  src:url(/fonts/inter-cyrillic-71d5ee93.woff2) format('woff2');
  unicode-range:U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116}
@font-face{font-family:'Inter';font-style:normal;font-weight:600;font-display:swap;
  src:url(/fonts/inter-cyrillic-71d5ee93.woff2) format('woff2');
  unicode-range:U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116}
@font-face{font-family:'Inter';font-style:normal;font-weight:700;font-display:swap;
  src:url(/fonts/inter-cyrillic-71d5ee93.woff2) format('woff2');
  unicode-range:U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116}
@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:400;font-display:swap;
  src:url(/fonts/jetbrains-mono-cyrillic-e17cfd15.woff2) format('woff2');
  unicode-range:U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116}
@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:500;font-display:swap;
  src:url(/fonts/jetbrains-mono-cyrillic-e17cfd15.woff2) format('woff2');
  unicode-range:U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116}
@font-face{font-family:'Oswald';font-style:normal;font-weight:500;font-display:swap;
  src:url(/fonts/oswald-cyrillic-95c3d8d1.woff2) format('woff2');
  unicode-range:U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116}
@font-face{font-family:'Oswald';font-style:normal;font-weight:600;font-display:swap;
  src:url(/fonts/oswald-cyrillic-95c3d8d1.woff2) format('woff2');
  unicode-range:U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116}
@font-face{font-family:'Oswald';font-style:normal;font-weight:700;font-display:swap;
  src:url(/fonts/oswald-cyrillic-95c3d8d1.woff2) format('woff2');
  unicode-range:U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116}
`;

const FOOTER = (extra) => `
  <footer>
    Фанатский трекер. Не связан с Valve Corporation, не одобрен и не спонсируется ею.<br>
    Данные: <a href="https://liquipedia.net/dota2/The_International/2026" rel="noopener">Liquipedia</a>
    (<a href="https://creativecommons.org/licenses/by-sa/3.0/" rel="license noopener">CC BY-SA 3.0</a>),
    OpenDota и Steam Web API.<br>
    <a href="/ru/">Трекер</a> · ${extra} ·
    <a href="/" hreflang="en">English</a>
  </footer>`;

/* ------------------------------------------------------------------ pages */

const PAGES = {
  "legal.html": {
    title: "Условия, конфиденциальность и отказ от ответственности — dota2tileague.com",
    desc:
      "Условия использования, политика конфиденциальности и отказ от ответственности " +
      "для dota2tileague.com — бесплатного некоммерческого фанатского трекера The International.",
    canon: "https://dota2tileague.com/ru/legal.html",
    alt: "https://dota2tileague.com/legal.html",
    body: `
  <a class="back" href="/ru/">&larr; Назад к трекеру</a>
  <h1>Условия, конфиденциальность и отказ от ответственности</h1>
  <div class="upd">Обновлено 15 августа 2026</div>

  <nav class="toc">
    <a href="#terms">Условия использования</a>
    <a href="#privacy">Конфиденциальность</a>
    <a href="#disclaimer">Отказ от ответственности</a>
    <a href="#contact">Контакты</a>
  </nav>

  <div class="hero">
    <div class="hero-lbl">Это не азартная игра</div>
    <p>dota2tileague.com — бесплатный сайт. Здесь <b>нет взносов, ставок, пари и призов
      какой-либо ценности</b>: ни денег, ни вещей, ни внутренней валюты — ничего, что можно
      купить, продать, передать или обменять. Лиги прогнозов — это закрытые компании друзей,
      которые играют на очки и на право хвастаться. Ничто на сайте не является букмекерским
      продуктом; ставки здесь не принимаются, не посредничаются и не рекламируются.</p>
  </div>

  <h2 id="terms">Условия использования</h2>
  <p>Пользуясь сайтом, вы принимаете эти условия. Если вы с ними не согласны — пожалуйста,
    не пользуйтесь сайтом.</p>

  <h3>Что это такое</h3>
  <p>Это бесплатный некоммерческий фанатский проект: он показывает результаты
    The International и позволяет вести приватные лиги прогнозов с друзьями. Сайт не связан
    с Valve, с организаторами турнира и с командами. Он предоставляется «как есть» и может
    быть изменён или закрыт в любой момент.</p>

  <h3>Возраст</h3>
  <p>Аккаунт можно создавать с 13 лет. Если вам меньше, пользуйтесь сайтом без регистрации —
    все результаты видны и без входа.</p>

  <h3>Ваш аккаунт</h3>
  <p>Вы отвечаете за то, что происходит под вашим аккаунтом, и за сохранность пароля.
    Не выдавайте себя за другого человека и не создавайте несколько аккаунтов, чтобы
    накрутить таблицу лидеров в чужой лиге. Мы можем закрыть аккаунт, который используется
    для обмана, спама или преследования других людей.</p>

  <h3>То, что вы пишете</h3>
  <p>Названия лиг, названия команд и никнеймы видны другим участникам. Не пишите там того,
    чего не сказали бы вслух: оскорблений, чужих персональных данных, рекламы. Мы можем
    удалить такой текст.</p>

  <h3>Лиги прогнозов</h3>
  <p>Лига — это приватная группа. Создатель лиги задаёт правила начисления очков и может
    их менять; очки не имеют никакой ценности за пределами лиги. Прогноз закрывается
    с началом матча, и после этого его нельзя изменить — даже если матч перенесли.
    Если данные о матче приходят с опозданием или с ошибкой, очки пересчитываются, когда
    результат исправлен.</p>

  <h3>Никаких гарантий</h3>
  <p>Мы стараемся показывать верные данные, но не гарантируем ни их точность, ни доступность
    сайта. Не принимайте на основании этого сайта решений, которые вам дорого обойдутся.
    В пределах, допустимых законом, мы не несём ответственности за убытки, возникшие
    из-за использования сайта.</p>

  <h3>Изменения и право</h3>
  <p>Эти условия могут меняться; дата вверху страницы показывает, когда это было в последний
    раз. К отношениям применяется право Румынии.</p>

  <h2 id="privacy">Конфиденциальность</h2>
  <p>Коротко: без регистрации мы не собираем о вас ничего, что позволяет вас опознать.
    С регистрацией мы храним минимум, необходимый для работы лиг.</p>

  <h3>Что мы храним и зачем</h3>
  <table>
    <tr><td><b>Email</b></td><td>Вход в аккаунт и восстановление пароля. Другим участникам не виден.</td></tr>
    <tr><td><b>Никнейм</b></td><td>Отображается в таблице лидеров вашей лиги. Выбираете вы.</td></tr>
    <tr><td><b>Ваши прогнозы</b></td><td>Начисление очков. Видны участникам вашей лиги после закрытия матча.</td></tr>
    <tr><td><b>Лиги, в которых вы состоите</b></td><td>Чтобы показать их вам при входе.</td></tr>
    <tr><td><b>Подписка на уведомления</b></td><td>Только если вы сами включили push. Хранится до отключения.</td></tr>
  </table>
  <p>Мы не собираем ваше настоящее имя, адрес, платёжные данные и не занимаемся рекламным
    профилированием. Мы ничего не продаём и не передаём третьим лицам для маркетинга.</p>

  <h3>Где это хранится</h3>
  <p>В Supabase, на серверах в Европейском союзе (Ирландия). Сайт раздаётся через Netlify.</p>

  <h3>Другие сервисы, к которым обращается браузер</h3>
  <p>Логотипы команд и портреты героев загружаются из Liquipedia и Steam, поэтому эти сервисы
    видят IP-адрес вашего браузера — как при открытии любой страницы с картинками. Шрифты мы
    раздаём сами, так что Google при чтении страницы ваш IP не получает. Встроенные трансляции
    на странице просмотра — это плееры Twitch и YouTube со своими правилами.</p>

  <h3>Cookie</h3>
  <p>Рекламных и аналитических cookie нет. Браузер хранит локально ваш вход, выбранный язык
    и мелкие настройки интерфейса — это не передаётся никуда.</p>

  <h3>Сколько мы это храним</h3>
  <p>Пока существует аккаунт. Удалите аккаунт — и связанные с ним прогнозы и членство в лигах
    удаляются вместе с ним. Результаты матчей — это публичные спортивные данные, они остаются.</p>

  <h3>Ваши права</h3>
  <p>По GDPR вы можете запросить копию своих данных, их исправление или удаление, а также
    подать жалобу в надзорный орган. Напишите нам с того адреса, на который зарегистрирован
    аккаунт, — так мы поймём, что это вы.</p>

  <h2 id="disclaimer">Отказ от ответственности и указание источников</h2>

  <h3>Мы не связаны с Valve</h3>
  <p>Это фанатский проект. Он не связан с Valve Corporation, не одобрен и не спонсируется ею.
    Dota 2 и The International — товарные знаки Valve Corporation. Все изображения из игры
    принадлежат Valve.</p>

  <h3>Откуда берутся данные</h3>
  <p>Расписание, составы и результаты — из <a href="https://liquipedia.net/dota2/The_International/2026" rel="noopener">Liquipedia</a>,
    доступной по лицензии <a href="https://creativecommons.org/licenses/by-sa/3.0/" rel="license noopener">CC BY-SA 3.0</a>.
    Прямые счета и статистика матчей — из OpenDota и Steam Web API.</p>

  <h3>Точность</h3>
  <p>Данные обновляются автоматически и могут отставать или содержать ошибки — особенно во
    время матча. Официальным источником всегда остаётся сам турнир. Нашли ошибку — напишите нам.</p>

  <h2 id="contact">Контакты</h2>
  <p>Вопросы, исправления, запросы данных или сообщения о нарушении правил выше:</p>
  <p><b><a href="mailto:support@dota2tileague.com">support@dota2tileague.com</a></b><br>
     <span class="dim">Общие вопросы: <a href="mailto:contact@dota2tileague.com">contact@dota2tileague.com</a></span></p>
  <p class="dim">Запросы на удаление — на тот же адрес. Пишите с почты самого аккаунта, чтобы мы
     знали, что это вы; что именно удаляется, описано на странице
     <a href="/ru/delete-account.html">удаления аккаунта</a>.</p>
${FOOTER('<a href="/ru/guide.html">Как это работает</a> · <a href="/ru/delete-account.html">Удалить аккаунт</a>')}`,
  },

  "guide.html": {
    title: "Как это работает — dota2tileague.com",
    desc:
      "Что есть на dota2tileague.com и как этим пользоваться: живые результаты The International, " +
      "лиги прогнозов с друзьями, любительские турниры и лестница.",
    canon: "https://dota2tileague.com/ru/guide.html",
    alt: "https://dota2tileague.com/guide.html",
    body: `
  <a class="back" href="/ru/">&larr; Назад к трекеру</a>
  <h1>Как это работает</h1>
  <div class="upd">Обзор сайта — что где находится и зачем нужно</div>

  <nav class="toc">
    <a href="#tracker">Трекер</a>
    <a href="#watch">Просмотр матчей</a>
    <a href="#leagues">Лиги прогнозов</a>
    <a href="#scoring">Начисление очков</a>
    <a href="#tournaments">Свои турниры</a>
    <a href="#ladder">Лестница</a>
    <a href="#account">Аккаунт</a>
  </nav>

  <div class="hero">
    <div class="hero-lbl">Если коротко</div>
    <p>Сайт делает три вещи: показывает, что происходит на The International прямо сейчас;
      позволяет спорить с друзьями на прогнозы (на очки, не на деньги); и даёт провести
      собственный любительский турнир с настоящей сеткой. Всё бесплатно, регистрация нужна
      только для лиг и турниров.</p>
  </div>

  <h2 id="tracker">Трекер</h2>
  <p>Главная страница — это сам турнир. Данные обновляются автоматически: расписание и составы
    приходят из Liquipedia, живые счета — из OpenDota и Steam.</p>

  <h3>Текущие и ближайшие</h3>
  <p>Матчи, которые идут прямо сейчас, и те, что начнутся следующими. У идущего матча видно
    счёт по серии; нажмите на строку матча, чтобы раскрыть все игры серии по отдельности —
    с длительностью, счётом по убийствам и разницей по золоту.</p>

  <h3>Групповой этап</h3>
  <p>Швейцарская система: <b>четыре победы</b> выводят напрямую в плей-офф, <b>четыре поражения</b> означают вылет. Все, кто между ними — с 4-го по 13-е место — играют раунд на вылет за последние пять мест.
    Команды сгруппированы по текущему счёту, и рядом с каждой видно, кого она обыграла
    и кому проиграла.</p>

  <h3>Плей-офф</h3>
  <p>Двойное выбывание: верхняя и нижняя сетка. Поражение в верхней сетке — это ещё не конец,
    команда падает в нижнюю. Поражение в нижней — вылет.</p>

  <h3>Команды и игроки</h3>
  <p>Профессиональные команды с мировым рейтингом, составы и статистика игроков.
    Нажмите на команду, чтобы увидеть её состав и последние результаты.</p>

  <h3>Герои</h3>
  <p>Что сейчас реально берут и банят в про-играх: самые оспариваемые герои, процент побед,
    способности и грани.</p>

  <h2 id="watch">Просмотр матчей</h2>
  <p>Кнопка «Смотреть матчи» открывает страницу, где все идущие игры собраны в одном месте:
    драфт обеих команд, живой счёт, разница по золоту и список трансляций на разных языках.
    Не нужно держать открытыми пять вкладок.</p>

  <h2 id="leagues">Лиги прогнозов</h2>
  <p>Лига — это приватная группа друзей. Один человек создаёт её и получает код входа,
    остальные заходят по коду. Всё бесплатно: <b>нет взносов, ставок и призов</b> — играют
    на очки и на право хвастаться.</p>

  <h3>Как начать</h3>
  <p>Нажмите «Создать лигу», задайте название и правила — или «Войти в лигу», если у вас
    есть код от друга. Дальше делайте прогнозы на матчи: выбираете победителя и, если хотите,
    точный счёт серии.</p>

  <h3>Когда закрываются прогнозы</h3>
  <p>Прогноз на матч закрывается с началом матча — после этого изменить его нельзя, и чужие
    прогнозы становятся видны всем. До этого момента никто не видит, что выбрали остальные.</p>

  <h3>Прогнозы на весь турнир</h3>
  <p>Помимо матчей можно заранее назвать чемпиона, финалистов и топ-4. Такие прогнозы
    закрываются до начала турнира и приносят больше очков — потому что делаются вслепую.</p>

  <h2 id="scoring">Начисление очков</h2>
  <p>Правила задаёт создатель лиги, поэтому в разных лигах они разные. Обычно это выглядит так:</p>
  <table>
    <tr><td><b>Угаданный победитель</b></td><td>основные очки за матч</td></tr>
    <tr><td><b>Точный счёт серии</b></td><td>бонус сверху, если угадали и 2–0 против 2–1</td></tr>
    <tr><td><b>Серия подряд</b></td><td>надбавка за несколько верных прогнозов подряд</td></tr>
    <tr><td><b>Итоги турнира</b></td><td>крупные очки за чемпиона, финалистов и топ-4</td></tr>
  </table>
  <p>Очки начисляются автоматически, когда результат матча подтверждён. Если результат пришёл
    с ошибкой и был исправлен, очки пересчитываются — таблица лидеров всегда отражает
    последние подтверждённые данные.</p>
  <p class="dim">В таблице лидеров столбец «Подряд» — это количество верных прогнозов подряд.
    Слово «серия» в нём не используется намеренно: серией здесь называется сам матч Bo3.</p>

  <h2 id="tournaments">Свои турниры</h2>
  <p>Можно провести собственный любительский турнир: настоящая сетка, автоматические пары
    по раундам и результаты, которые проверяются по ID матчей Dota, а не на честном слове.</p>
  <p>Создайте турнир, выберите формат — одиночное или двойное выбывание, группы или швейцарка —
    и разошлите приглашения. Капитаны команд регистрируются сами, договариваются о времени между
    собой и после игры отправляют результат. Совпадающие ID матчей подтверждают его автоматически.</p>

  <h2 id="ladder">Лестница</h2>
  <p>Постоянный рейтинг для любительских команд, без расписания. Поставьте команду в лестницу,
    вызывайте другие команды, играйте когда удобно — рейтинг двигается сам. Подходит тем,
    кто не хочет быть привязанным к дате турнира.</p>

  <h2 id="account">Аккаунт</h2>
  <p>Результаты турнира и страница просмотра открыты всем без регистрации. Аккаунт нужен только
    чтобы делать прогнозы, состоять в лиге, проводить турнир или стоять в лестнице.</p>
  <p>Для регистрации нужен email и никнейм — он и будет виден остальным. Настоящее имя и
    платёжные данные не запрашиваются никогда. Что именно хранится, описано в разделе
    <a href="/ru/legal.html#privacy">конфиденциальности</a>; удалить аккаунт можно
    <a href="/ru/delete-account.html">здесь</a>.</p>

  <h3>Установить на телефон</h3>
  <p>Сайт можно поставить на домашний экран как обычное приложение — оно открывается
    без адресной строки и работает быстрее при повторных заходах. В браузере телефона
    выберите «Добавить на главный экран».</p>
${FOOTER('<a href="/ru/legal.html">Условия и конфиденциальность</a> · <a href="/ru/delete-account.html">Удалить аккаунт</a>')}`,
  },

  "delete-account.html": {
    title: "Удаление аккаунта — dota2tileague.com",
    desc: "Как удалить аккаунт на dota2tileague.com и что именно удаляется вместе с ним.",
    canon: "https://dota2tileague.com/ru/delete-account.html",
    alt: "https://dota2tileague.com/delete-account.html",
    body: `
  <a class="back" href="/ru/">&larr; Назад к трекеру</a>
  <h1>Удаление аккаунта</h1>
  <div class="upd">Обновлено 15 августа 2026</div>

  <div class="hero">
    <div class="hero-lbl">Сейчас — по письму</div>
    <p>Кнопка удаления временно отключена: мы переделываем её так, чтобы удаление админа лиги
      не могло задеть прогнозы остальных участников. Пока что удаление делается вручную —
      напишите нам, и мы всё сделаем.</p>
  </div>

  <h2>Как запросить удаление</h2>
  <p>Отправьте письмо на <b><a href="mailto:support@dota2tileague.com">support@dota2tileague.com</a></b>
    <b>с того адреса, на который зарегистрирован аккаунт</b> — так мы понимаем, что это
    действительно вы, и никто не может удалить чужой аккаунт. Тема письма: «Удаление аккаунта».</p>
  <p>Мы отвечаем подтверждением и удаляем аккаунт в течение 30 дней, как требует GDPR.
    Обычно — быстрее.</p>

  <h2>Что удаляется</h2>
  <table>
    <tr><td><b>Ваш аккаунт и email</b></td><td>удаляется</td></tr>
    <tr><td><b>Ваш никнейм</b></td><td>удаляется</td></tr>
    <tr><td><b>Ваши прогнозы</b></td><td>удаляются</td></tr>
    <tr><td><b>Ваше членство в лигах</b></td><td>удаляется</td></tr>
    <tr><td><b>Подписка на уведомления</b></td><td>удаляется</td></tr>
    <tr><td><b>Результаты матчей турнира</b></td><td>остаются — это публичные спортивные данные, они не про вас</td></tr>
  </table>

  <h2>Если вы админ лиги</h2>
  <p>Скажите в письме, кому передать лигу. Если передавать некому, лига удаляется вместе
    с аккаунтом — предупредите участников заранее, восстановить её будет нельзя.</p>

  <h2>Передумали?</h2>
  <p>До подтверждения — просто напишите нам ещё раз. После удаления восстановить данные
    невозможно: они удаляются, а не помечаются удалёнными.</p>
${FOOTER('<a href="/ru/guide.html">Как это работает</a> · <a href="/ru/legal.html">Условия и конфиденциальность</a>')}`,
  },
};

/* ------------------------------------------------------------------ build */

let built = 0;
for (const [file, page] of Object.entries(PAGES)) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");

  const headEnd = src.indexOf("</head>");
  if (headEnd < 0) throw new Error(`${file}: no </head>`);
  let head = src.slice(0, headEnd);

  // Relative font URLs 404 from /ru/ — this is the difference between the real
  // typeface and a system fallback.
  const relFonts = (head.match(/url\(fonts\//g) || []).length;
  head = head.replace(/url\(fonts\//g, "url(/fonts/");

  head = head.replace(/<html lang="en">/, '<html lang="ru">');
  head = head.replace(/<title>[\s\S]*?<\/title>/, `<title>${page.title}</title>`);
  head = head.replace(
    /<meta name="description" content="[\s\S]*?">/,
    `<meta name="description" content="${page.desc}">`
  );
  head = head.replace(
    /<\/style>/,
    `${CYRILLIC}</style>`
  );
  head = head.replace(
    /<style>/,
    `<link rel="canonical" href="${page.canon}">\n` +
      `<link rel="alternate" hreflang="en" href="${page.alt}">\n` +
      `<link rel="alternate" hreflang="ru" href="${page.canon}">\n<style>`
  );

  if (!/lang="ru"/.test(head)) throw new Error(`${file}: lang not switched`);
  if (!/inter-cyrillic/.test(head)) throw new Error(`${file}: Cyrillic faces missing`);
  if (/url\(fonts\//.test(head)) throw new Error(`${file}: relative font URL survived`);

  const out = `${head}</head>\n<body>\n<div class="wrap">${page.body}\n</div>\n</body>\n</html>\n`;
  fs.writeFileSync(path.join(__dirname, file), out, "utf8");

  console.log(
    `  ru/${file.padEnd(20)} ${String(Math.round(out.length / 1024)).padStart(3)} KB ` +
      `(${relFonts} font URLs made absolute)`
  );
  built++;
}
console.log(`\n${built} Russian pages built from their English originals`);
