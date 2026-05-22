import {
  SlashCommandBuilder,
  InteractionContextType,
  ApplicationIntegrationType,
} from "discord.js";

const CONTEXTS = [
  InteractionContextType.Guild,
  InteractionContextType.BotDM,
  InteractionContextType.PrivateChannel,
];
const INTEGRATION_TYPES = [
  ApplicationIntegrationType.GuildInstall,
  ApplicationIntegrationType.UserInstall,
];

const VOICE_CHOICES = [
  { name: "kanya — Mac Kanya Enhanced (Thai, free)", value: "kanya" },
  { name: "kanya-compact — Mac Kanya compact (Thai, free)", value: "kanya-compact" },
  { name: "narisa — Mac Narisa (Thai, free)", value: "narisa" },
  { name: "niwat — Edge TTS Thai male (free)", value: "niwat" },
  { name: "premwadee — Edge TTS Thai female (free)", value: "premwadee" },
  { name: "leda — Google Chirp3-HD Leda (premium, paid)", value: "leda" },
] as const;

const TRIGGER_ACTION_CHOICES = [
  { name: "anyone — ทุกคนในห้อง trigger ได้", value: "anyone" },
  { name: "owner-only — เฉพาะ DC_OWNER_IDS", value: "owner-only" },
  { name: "selected — ตามรายชื่อใน allow-list", value: "selected" },
  { name: "add — เพิ่มผู้ใช้เข้า allow-list", value: "add" },
  { name: "remove — ลบผู้ใช้ออกจาก allow-list", value: "remove" },
  { name: "list — โชว์ allow-list ปัจจุบัน", value: "list" },
] as const;

function buildCodeyCommand(name: string, description: string) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(CONTEXTS)
    .setIntegrationTypes(INTEGRATION_TYPES)
    .addSubcommand((sub) =>
      sub.setName("help").setDescription("โชว์คำสั่งทั้งหมด + ขั้นตอนการใช้งาน"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("join")
        .setDescription("โคดี้เข้า voice channel (DM: ใส่ channel-id; guild: ตามพี่)")
        .addStringOption((opt) =>
          opt.setName("channel-id").setDescription("Voice channel ID — DM only").setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("leave").setDescription("ออกจาก voice channel + save transcript"),
    )
    .addSubcommand((sub) =>
      sub.setName("save").setDescription("Save transcript โดยไม่ออก"),
    )
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("ดูสถานะ (channel, duration, segments)"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("note")
        .setDescription("เพิ่ม note ลง transcript")
        .addStringOption((opt) =>
          opt.setName("text").setDescription("ข้อความ note").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("speak-on").setDescription("เปิด mic + TTS reply on trigger"),
    )
    .addSubcommand((sub) =>
      sub.setName("speak-off").setDescription("ปิด mic — ฟังอย่างเดียว"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("say")
        .setDescription("ให้โคดี้พูดข้อความเข้า voice channel")
        .addStringOption((opt) =>
          opt.setName("text").setDescription("ข้อความ").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("think")
        .setDescription("ส่งข้อความเข้า Claude — คิด + TTS ตอบ")
        .addStringOption((opt) =>
          opt.setName("message").setDescription("คำถาม / ข้อความ").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("trigger")
        .setDescription("ตั้งใครพูด trigger ได้ (mode + allow-list)")
        .addStringOption((opt) =>
          opt
            .setName("action")
            .setDescription("เลือก action")
            .setRequired(true)
            .addChoices(...TRIGGER_ACTION_CHOICES),
        )
        .addUserOption((opt) =>
          opt.setName("user").setDescription("ผู้ใช้ (จำเป็นสำหรับ add/remove)").setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("voice")
        .setDescription("สลับเสียง TTS")
        .addStringOption((opt) =>
          opt
            .setName("profile")
            .setDescription("เลือก voice profile")
            .setRequired(true)
            .addChoices(...VOICE_CHOICES),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("stay")
        .setDescription("Persistent mode — อยู่ในห้องเสียงทั้งวัน (default 24h, max 24h)")
        .addNumberOption((opt) =>
          opt
            .setName("hours")
            .setDescription("ระยะเวลา (ชั่วโมง) — default 24, max 24")
            .setRequired(false)
            .setMinValue(0.1)
            .setMaxValue(24),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("unstay")
        .setDescription("ปิด persistent mode — auto-leave กลับมาทำงานปกติ"),
    );
}

function aliasBase(name: string, description: string) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(CONTEXTS)
    .setIntegrationTypes(INTEGRATION_TYPES);
}

const cjCommand = aliasBase("cj", "alias: /codey join — เข้า voice channel").addStringOption(
  (opt) =>
    opt.setName("channel-id").setDescription("Voice channel ID (DM only)").setRequired(false),
);

const clCommand = aliasBase("cl", "alias: /codey leave — ออก + save");
const csCommand = aliasBase("cs", "alias: /codey save — save mid-session");
const cstCommand = aliasBase("cst", "alias: /codey status");
const chCommand = aliasBase("ch", "alias: /codey help");
const conCommand = aliasBase("con", "alias: /codey speak-on");
const coffCommand = aliasBase("coff", "alias: /codey speak-off");

const cnCommand = aliasBase("cn", "alias: /codey note").addStringOption((opt) =>
  opt.setName("text").setDescription("ข้อความ note").setRequired(true),
);

const csayCommand = aliasBase("csay", "alias: /codey say — TTS speak text").addStringOption(
  (opt) => opt.setName("text").setDescription("ข้อความ").setRequired(true),
);

const ctCommand = aliasBase("ct", "alias: /codey think — Claude reply via TTS").addStringOption(
  (opt) => opt.setName("message").setDescription("คำถาม").setRequired(true),
);

const cvCommand = aliasBase("cv", "alias: /codey voice — สลับเสียง").addStringOption((opt) =>
  opt.setName("profile").setDescription("voice profile").setRequired(true).addChoices(...VOICE_CHOICES),
);

const ctrCommand = aliasBase("ctr", "alias: /codey trigger — manage allow-list")
  .addStringOption((opt) =>
    opt
      .setName("action")
      .setDescription("เลือก action")
      .setRequired(true)
      .addChoices(...TRIGGER_ACTION_CHOICES),
  )
  .addUserOption((opt) =>
    opt.setName("user").setDescription("ผู้ใช้ (สำหรับ add/remove)").setRequired(false),
  );

const cviCommand = aliasBase("cvi", "alias: /codey join — voice-in").addStringOption((opt) =>
  opt.setName("channel-id").setDescription("Voice channel ID (DM only)").setRequired(false),
);
const cvoCommand = aliasBase("cvo", "alias: /codey leave — voice-out");

const cstayCommand = aliasBase("cstay", "alias: /codey stay — keep Codey in channel (≤24h)")
  .addNumberOption((opt) =>
    opt.setName("hours").setDescription("hours, max 24 (default 24)").setRequired(false)
      .setMinValue(0.1).setMaxValue(24),
  );
const cunstayCommand = aliasBase("cunstay", "alias: /codey unstay — turn off persistent mode");

export const codeyCommand = buildCodeyCommand(
  "codey",
  "Codey — Discord voice transcriber & secretary",
);
export const codeyAliasCommand = buildCodeyCommand("cod", "alias ของ /codey");

export const ALIAS_TO_SUBCOMMAND: Readonly<Record<string, string>> = {
  cj: "join",
  cl: "leave",
  cs: "save",
  cst: "status",
  cn: "note",
  ch: "help",
  con: "speak-on",
  coff: "speak-off",
  csay: "say",
  ct: "think",
  ctr: "trigger",
  cv: "voice",
  cvi: "join",
  cvo: "leave",
  cstay: "stay",
  cunstay: "unstay",
};

export const YOI_BASE_NAMES = new Set(["codey", "cod"]);

export const commands = [
  codeyCommand,
  codeyAliasCommand,
  cjCommand,
  clCommand,
  csCommand,
  cstCommand,
  cnCommand,
  chCommand,
  conCommand,
  coffCommand,
  csayCommand,
  ctCommand,
  ctrCommand,
  cvCommand,
  cviCommand,
  cvoCommand,
  cstayCommand,
  cunstayCommand,
];
