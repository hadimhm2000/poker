// Terms of use and privacy policy. DRAFTS: written from how the app actually handles data,
// not reviewed by a lawyer. The bracketed placeholders (operator, country, contact) are
// filled in once the company question in the plan is settled. English and Persian exist;
// other languages show the English text with a note.

export interface LegalSection {
  title: string;
  body: string[];
}
export type LegalDoc = "terms" | "privacy";

const en: Record<LegalDoc, LegalSection[]> = {
  terms: [
    {
      title: "What Poker Home is",
      body: [
        "Poker Home is a scorekeeping service for private home games among friends. It records buy-ins, rebuys and results, and shows statistics.",
        "Poker Home never holds, moves or collects money for games. Any payment between players happens outside the service and is their own arrangement.",
      ],
    },
    {
      title: "Who may use it",
      body: [
        "You must be at least 18 years old, or the age of majority where you live if that is higher.",
        "You are responsible for making sure your games are legal where you play. Poker Home is not a gambling service and does not offer games for real money.",
      ],
    },
    {
      title: "Your account",
      body: [
        "Keep your password and second factor safe. You are responsible for what happens under your account.",
        "A home's host decides who joins the home and can remove members. Closed games cannot be changed by anyone, including us.",
      ],
    },
    {
      title: "Plans and payments",
      body: [
        "The free plan has limits described on the pricing page. The Pro subscription is sold by our payment provider, who acts as merchant of record and handles tax, invoices and refunds under its own terms.",
        "You can cancel at any time; Pro stays active until the end of the paid period. Nothing you created is deleted when a plan ends; extra homes become read-only.",
      ],
    },
    {
      title: "Acceptable use",
      body: [
        "Do not use the service to harass people, to break the law, to attack or overload the service, or to access data that is not yours.",
        "We may suspend accounts that do so.",
      ],
    },
    {
      title: "No warranty",
      body: [
        "The service is provided as is. We work to keep it available and correct, but we are not liable for losses from outages, errors, or disputes between players, to the extent the law allows.",
      ],
    },
    {
      title: "Changes and contact",
      body: [
        "We may update these terms and will announce important changes in the app. The operator is [OPERATOR NAME], [COUNTRY]. Contact: [CONTACT EMAIL].",
      ],
    },
  ],
  privacy: [
    {
      title: "What we store",
      body: [
        "Account: email, display name, language, and a password hash (Argon2id; we never see your password). If you turn on two-step verification, the authenticator secret is stored encrypted, and recovery codes only as hashes.",
        "Logins you connect: the Telegram account id, and the Google or Apple account id and email.",
        "Game data you or your host enter: player names, buy-ins, results, debts and payments marked as paid, game nights and answers. Payment details a player adds for others to pay them are stored encrypted.",
        "Security data: signed-in devices (browser name), a salted hash of the IP address, and an audit log of changes.",
      ],
    },
    {
      title: "Why",
      body: [
        "To run the service you asked for (keeping score, statistics, reminders), to keep accounts secure, and to bill Pro subscriptions. We do not sell data and we do not show ads.",
      ],
    },
    {
      title: "Who sees it",
      body: [
        "Members of a home see that home's games and statistics. A shared result card shows only what is on it.",
        "Site admins do not browse games. They can open one home's history only for a support request, for one hour, with the reason recorded in a log that cannot be edited.",
        "Service providers process data for us: hosting and database, email delivery, the payment provider (for subscribers), Telegram (if you use the bot), Google or Apple (if you sign in with them), and, only for features you use, speech-to-text and an AI provider that writes the optional night story.",
      ],
    },
    {
      title: "How long",
      body: [
        "Until you delete your account. Closed games are part of other players' records, so they stay after you leave, with your name replaced. Backups roll over within 30 days.",
      ],
    },
    {
      title: "Your rights",
      body: [
        "In Settings you can download all data tied to your account as a file, correct your name, choose which reminders you get, and delete your account.",
        "For anything else, contact [CONTACT EMAIL]. Depending on where you live, you may also complain to your data protection authority.",
      ],
    },
    {
      title: "Cookies",
      body: [
        "Only what the service needs: the sign-in session, short-lived security cookies during sign-in and two-step setup, and your theme choice. No tracking or advertising cookies.",
      ],
    },
  ],
};

const fa: Record<LegalDoc, LegalSection[]> = {
  terms: [
    {
      title: "پوکر هوم چیست",
      body: [
        "پوکر هوم سرویس ثبت امتیاز برای بازی‌های خانگی و خصوصی میان دوستان است. خرید ورودی، ری‌بای و نتیجه‌ها را ثبت می‌کند و آمار نشان می‌دهد.",
        "پوکر هوم هرگز پولی را برای بازی نگه نمی‌دارد، جابه‌جا نمی‌کند یا دریافت نمی‌کند. هر پرداختی میان بازیکنان بیرون از سرویس و به توافق خودشان انجام می‌شود.",
      ],
    },
    {
      title: "چه کسی می‌تواند استفاده کند",
      body: [
        "باید دست‌کم ۱۸ سال داشته باشید، یا سن قانونی محل زندگی‌تان اگر بیشتر است.",
        "قانونی بودن بازی در محل بازی به عهده‌ی خود شماست. پوکر هوم سرویس قمار نیست و بازی با پول واقعی ارائه نمی‌کند.",
      ],
    },
    {
      title: "حساب شما",
      body: [
        "رمز عبور و عامل دوم را امن نگه دارید. مسئولیت کارهایی که با حساب شما انجام می‌شود با شماست.",
        "میزبان هر home تعیین می‌کند چه کسی عضو شود و می‌تواند اعضا را حذف کند. بازی بسته‌شده را هیچ‌کس، حتی ما، نمی‌تواند تغییر دهد.",
      ],
    },
    {
      title: "پلن‌ها و پرداخت",
      body: [
        "پلن رایگان محدودیت‌هایی دارد که در صفحه‌ی قیمت‌ها آمده است. اشتراک Pro را ارائه‌دهنده‌ی پرداخت ما به عنوان فروشنده‌ی رسمی می‌فروشد و مالیات، فاکتور و بازپرداخت را طبق شرایط خودش انجام می‌دهد.",
        "هر وقت بخواهید می‌توانید لغو کنید؛ Pro تا پایان دوره‌ی پرداخت‌شده فعال می‌ماند. با پایان پلن چیزی از داده‌هایتان پاک نمی‌شود؛ home های اضافه فقط‌خواندنی می‌شوند.",
      ],
    },
    {
      title: "استفاده‌ی مجاز",
      body: [
        "از سرویس برای آزار دیگران، کار غیرقانونی، حمله یا ایجاد بار بیش از حد، یا دسترسی به داده‌ای که مال شما نیست استفاده نکنید.",
        "ممکن است حساب‌هایی را که چنین کنند مسدود کنیم.",
      ],
    },
    {
      title: "بدون ضمانت",
      body: [
        "سرویس همان‌طور که هست ارائه می‌شود. برای در دسترس و درست بودن آن تلاش می‌کنیم، اما تا جایی که قانون اجازه می‌دهد مسئول زیان ناشی از قطعی، خطا یا اختلاف میان بازیکنان نیستیم.",
      ],
    },
    {
      title: "تغییرات و تماس",
      body: [
        "ممکن است این شرایط را به‌روز کنیم و تغییرات مهم را در برنامه اعلام می‌کنیم. اداره‌کننده: [نام اداره‌کننده]، [کشور]. تماس: [ایمیل تماس].",
      ],
    },
  ],
  privacy: [
    {
      title: "چه چیزهایی نگه می‌داریم",
      body: [
        "حساب: ایمیل، نام نمایشی، زبان و هش رمز عبور (Argon2id؛ رمز شما را هرگز نمی‌بینیم). اگر تأیید دومرحله‌ای را روشن کنید، کلید آن رمزگذاری‌شده و کدهای بازیابی فقط به صورت هش نگه داشته می‌شوند.",
        "روش‌های ورودی که وصل می‌کنید: شناسه‌ی حساب تلگرام، و شناسه و ایمیل حساب گوگل یا اپل.",
        "داده‌های بازی که شما یا میزبان وارد می‌کنید: نام بازیکنان، ورودی‌ها، نتیجه‌ها، بدهی‌ها و پرداخت‌های علامت‌خورده، شب‌های بازی و پاسخ‌ها. اطلاعات پرداختی که بازیکن برای دریافت پول وارد می‌کند رمزگذاری‌شده نگه داشته می‌شود.",
        "داده‌های امنیتی: دستگاه‌های واردشده (نام مرورگر)، هش نمک‌دار نشانی IP و گزارش تغییرات.",
      ],
    },
    {
      title: "برای چه",
      body: [
        "برای اجرای سرویسی که خواسته‌اید (ثبت امتیاز، آمار، یادآوری)، امن نگه داشتن حساب‌ها و صورت‌حساب اشتراک Pro. داده‌ها را نمی‌فروشیم و تبلیغ نشان نمی‌دهیم.",
      ],
    },
    {
      title: "چه کسی می‌بیند",
      body: [
        "اعضای هر home بازی‌ها و آمار همان home را می‌بینند. کارت نتیجه‌ی اشتراکی فقط همان چیزی را نشان می‌دهد که رویش هست.",
        "ادمین‌های سایت بازی‌ها را مرور نمی‌کنند. فقط برای درخواست پشتیبانی، برای یک ساعت و با ثبت دلیل در گزارشی تغییرناپذیر، تاریخچه‌ی یک home را باز می‌کنند.",
        "ارائه‌دهندگان خدمات برای ما داده پردازش می‌کنند: میزبانی و پایگاه داده، ارسال ایمیل، ارائه‌دهنده‌ی پرداخت (برای مشترکان)، تلگرام (اگر از ربات استفاده کنید)، گوگل یا اپل (اگر با آن‌ها وارد شوید)، و فقط برای قابلیت‌هایی که استفاده می‌کنید، تبدیل گفتار به متن و یک ارائه‌دهنده‌ی هوش مصنوعی که داستان اختیاری شب را می‌نویسد.",
      ],
    },
    {
      title: "تا کی",
      body: [
        "تا وقتی حسابتان را حذف کنید. بازی‌های بسته‌شده بخشی از سابقه‌ی بازیکنان دیگر است، پس پس از رفتن شما با نام جایگزین می‌ماند. نسخه‌های پشتیبان ظرف ۳۰ روز جایگزین می‌شوند.",
      ],
    },
    {
      title: "حقوق شما",
      body: [
        "در تنظیمات می‌توانید همه‌ی داده‌های حسابتان را به صورت فایل دریافت کنید، نامتان را اصلاح کنید، یادآوری‌ها را انتخاب کنید و حسابتان را حذف کنید.",
        "برای هر مورد دیگر با [ایمیل تماس] در ارتباط باشید. بسته به محل زندگی، می‌توانید به مرجع حفاظت از داده‌ها هم شکایت کنید.",
      ],
    },
    {
      title: "کوکی‌ها",
      body: [
        "فقط آنچه سرویس لازم دارد: نشست ورود، کوکی‌های امنیتی کوتاه‌مدت هنگام ورود و راه‌اندازی تأیید دومرحله‌ای، و انتخاب ظاهر. هیچ کوکی ردیابی یا تبلیغاتی نداریم.",
      ],
    },
  ],
};

const TEXTS: Record<string, Record<LegalDoc, LegalSection[]>> = { en, fa };

/** The text in this language, or English (translated: false). */
export function legalText(doc: LegalDoc, locale: string): { sections: LegalSection[]; translated: boolean } {
  const t = TEXTS[locale];
  return t ? { sections: t[doc], translated: true } : { sections: en[doc], translated: false };
}

export const LEGAL_UPDATED = "2026-09-30";
