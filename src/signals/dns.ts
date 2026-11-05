// DNS / MX / SPF tool detection — the most reliable signal in the set: plain DNS queries, no HTTP,
// no scraping, nothing to block. What it reveals per domain:
//   • MX records → who runs their email (Google / Microsoft / Zoho / …). A change = provider switch.
//   • SPF `include:` entries → which sending/marketing/CRM tools the domain AUTHORIZES to send as
//     them (Klaviyo, HubSpot, Outreach, Mailgun, …). An added include = they just bought that tool.
//   • DMARC record → email-security maturity.
// Facts = current provider + tool list; diffs vs domain_state → dns-mx-changed / dns-tool-added /
// dns-tool-removed. First scan is baseline-only. A transient DNS failure never touches stored state
// (so an outage can't fake "tool removed" signals).
import { resolveMx, resolveTxt } from "node:dns/promises";
import { dbGetDomainState, dbReplaceDomainState } from "../db.ts";
import type { SignalProducer, SignalDraft, ProducerResult } from "./types.ts";

// MX host → provider label (match on the host's tail).
const MX_PROVIDERS: Array<[string, string]> = [
  ["google.com", "google"], ["googlemail.com", "google"],
  ["outlook.com", "microsoft"], ["office365.us", "microsoft"], ["protection.outlook", "microsoft"],
  ["zoho.com", "zoho"], ["zohomail", "zoho"],
  ["protonmail", "proton"], ["pphosted.com", "proofpoint"], ["mimecast", "mimecast"],
  ["barracuda", "barracuda"], ["yahoodns", "yahoo"], ["fastmail", "fastmail"],
  ["mailgun.org", "mailgun"], ["messagingengine", "fastmail"], ["icloud.com", "apple"],
  ["secureserver.net", "godaddy"], ["mail.ovh", "ovh"], ["yandex", "yandex"],
  // European + Indian hosters. Without these, a German company on IONOS or an Indian one on Rediff
  // came back as "other:<domain>" and never matched a known provider, so a real mail-provider switch
  // (a strong buying signal) read as noise.
  ["ionos", "ionos"], ["1and1", "ionos"], ["kundenserver", "ionos"], ["perfora.net", "ionos"],
  ["strato", "strato"], ["mailbox.org", "mailbox.org"], ["hosteurope", "host-europe"],
  ["all-inkl", "all-inkl"], ["df.eu", "domainfactory"], ["netcup", "netcup"], ["hetzner", "hetzner"],
  ["gandi.net", "gandi"], ["infomaniak", "infomaniak"], ["open-xchange", "open-xchange"],
  ["one.com", "one.com"], ["loopia", "loopia"], ["binero", "binero"], ["simply.com", "simply.com"],
  ["home.pl", "home.pl"], ["nazwa.pl", "nazwa.pl"], ["seznam.cz", "seznam"],
  ["rediffmailpro", "rediff"], ["mithi", "mithi"], ["net4india", "net4"],
  ["qq.com", "tencent"], ["exmail.qq", "tencent-exmail"], ["aliyun", "alibaba"], ["mxhichina", "alibaba"],
  ["sakura.ne.jp", "sakura"], ["cybozu", "cybozu"], ["naver.com", "naver"], ["daum.net", "kakao"],
];
// SPF include host → tool name (substring match). GTM-relevant senders first.
const SPF_TOOLS: Array<[string, string]> = [
  ["klaviyo", "Klaviyo"], ["hubspot", "HubSpot"], ["mailgun", "Mailgun"], ["sendgrid", "SendGrid"],
  ["salesforce", "Salesforce"], ["pardot", "Pardot"], ["exacttarget", "Salesforce Marketing Cloud"],
  ["outreach.io", "Outreach"], ["salesloft", "Salesloft"], ["apollo.io", "Apollo"],
  ["mailchimp", "Mailchimp"], ["mcsv.net", "Mailchimp"], ["mandrillapp", "Mailchimp Transactional"],
  ["zendesk", "Zendesk"], ["intercom", "Intercom"], ["freshdesk", "Freshdesk"], ["freshemail", "Freshworks"],
  ["amazonses", "Amazon SES"], ["sparkpost", "SparkPost"], ["postmark", "Postmark"], ["mtasv.net", "Postmark"],
  ["sendinblue", "Brevo"], ["brevo", "Brevo"], ["constantcontact", "Constant Contact"],
  ["marketo", "Marketo"], ["mktomail", "Marketo"], ["braze", "Braze"], ["customer.io", "Customer.io"],
  ["mixmax", "Mixmax"], ["lemlist", "lemlist"], ["instantly", "Instantly"], ["smartlead", "Smartlead"],
  ["hs-send", "HubSpot"], ["dripemail", "Drip"], ["activecampaign", "ActiveCampaign"],
  ["monday.com", "monday.com"], ["atlassian", "Atlassian"], ["stripe.com", "Stripe"],
  ["qualtrics", "Qualtrics"], ["surveymonkey", "SurveyMonkey"], ["greenhouse.io", "Greenhouse"],
  ["lever.co", "Lever"], ["ashbyhq", "Ashby"], ["gusto.com", "Gusto"], ["rippling", "Rippling"],
  ["docusign", "DocuSign"], ["pandadoc", "PandaDoc"], ["netsuite", "NetSuite"],
  // Non-US senders. A European or Indian company's marketing stack is invisible to a US-only list —
  // it would show an SPF record full of includes and recognise none of them.
  ["mailjet", "Mailjet"], ["mjt.lu", "Mailjet"], ["sarbacane", "Sarbacane"], ["sendinblue.net", "Brevo"],
  ["cleverreach", "CleverReach"], ["rapidmail", "Rapidmail"], ["inxmail", "Inxmail"],
  ["episerver", "Optimizely Campaign"], ["optimizely", "Optimizely"], ["emarsys", "Emarsys"],
  ["mailup", "MailUp"], ["contactlab", "ContactLab"], ["mailerlite", "MailerLite"],
  ["getresponse", "GetResponse"], ["freshmail", "FreshMail"], ["sendpulse", "SendPulse"],
  ["unisender", "UniSender"], ["dotdigital", "Dotdigital"], ["dotmailer", "Dotdigital"],
  ["adestra", "Adestra"], ["pure360", "Pure360"], ["mapp.com", "Mapp"], ["teradata", "Mapp"],
  ["zoho.eu", "Zoho"], ["zeptomail", "Zoho ZeptoMail"], ["netcorecloud", "Netcore"], ["pepipost", "Netcore"],
  ["kaleyra", "Kaleyra"], ["gupshup", "Gupshup"], ["msg91", "MSG91"], ["exotel", "Exotel"],
  ["moengage", "MoEngage"], ["clevertap", "CleverTap"], ["webengage", "WebEngage"],
  ["personio", "Personio"], ["smartrecruiters", "SmartRecruiters"], ["workable", "Workable"],
  ["recruitee", "Recruitee"], ["teamtailor", "Teamtailor"], ["factorialhr", "Factorial"],
  ["mollie", "Mollie"], ["adyen", "Adyen"], ["gocardless", "GoCardless"], ["razorpay", "Razorpay"],
];
const mxProvider = (host: string): string => {
  const h = host.toLowerCase();
  for (const [pat, label] of MX_PROVIDERS) if (h.includes(pat)) return label;
  const parts = h.replace(/\.$/, "").split(".");
  return "other:" + parts.slice(-2).join(".");
};
const spfTool = (include: string): string | null => {
  const h = include.toLowerCase();
  for (const [pat, label] of SPF_TOOLS) if (h.includes(pat)) return label;
  return null;
};

export const dnsProducer: SignalProducer = {
  key: "dns",
  label: "DNS / email tools",
  description: "MX + SPF records reveal the email provider and authorized sending tools (Klaviyo, Outreach, HubSpot…). Pure DNS, most reliable.",
  flagged: true,
  filterable: false,   // 90% of checked domains hit — see SignalProducer.filterable
  async check(domain, ctx): Promise<ProducerResult> {
    const facts: Record<string, string> = {};
    const state: Record<string, string> = {};
    let resolvedAnything = false;
    // Prior snapshot fetched up-front so a sub-lookup that fails TRANSIENTLY (timeout/SERVFAIL, not a
    // genuine "no records" answer) can carry its prior keys forward — otherwise a resolver hiccup on
    // one record type fabricates false "removed"/"changed" diffs and dbReplaceDomainState wipes the
    // real state. A definitive no-records answer (ENODATA/ENOTFOUND) is NOT transient: real removal.
    const prior = dbGetDomainState(domain, "dns");
    const isNoRecords = (e: unknown): boolean => {
      const c = (e as NodeJS.ErrnoException)?.code;
      return c === "ENODATA" || c === "ENOTFOUND";
    };
    const carryForward = (pred: (k: string) => boolean): void => {
      for (const k of prior.keys()) if (pred(k)) { state[k] = prior.get(k) ?? ""; resolvedAnything = true; }
    };

    // MX → provider
    try {
      const mx = await resolveMx(domain);
      if (mx.length) {
        resolvedAnything = true;
        const primary = mx.sort((a, b) => a.priority - b.priority)[0]!.exchange;
        const provider = mxProvider(primary);
        facts["Email provider"] = provider;
        state["mx"] = provider;
      }
    } catch (e) { if (!isNoRecords(e)) carryForward((k) => k === "mx"); } // transient → keep prior MX

    // TXT → SPF includes → tools; also raw include hosts for state (so unknown tools still diff)
    try {
      const txt = (await resolveTxt(domain)).map((parts) => parts.join(""));
      const spf = txt.find((t) => t.toLowerCase().startsWith("v=spf1"));
      if (spf) {
        resolvedAnything = true;
        const includes = [...spf.matchAll(/include:([^\s]+)/gi)].map((m) => m[1]!.toLowerCase());
        const tools = new Set<string>();
        for (const inc of includes) {
          const tool = spfTool(inc);
          state[`spf:${tool ?? inc}`] = "1";
          if (tool) tools.add(tool);
        }
        if (tools.size) facts["SPF tools"] = [...tools].join(", ");
        facts["SPF includes"] = String(includes.length);
      }
    } catch (e) { if (!isNoRecords(e)) carryForward((k) => k.startsWith("spf:")); } // transient → keep prior tools

    // DMARC policy
    try {
      const dmarc = (await resolveTxt(`_dmarc.${domain}`)).map((p) => p.join("")).find((t) => t.toLowerCase().startsWith("v=dmarc1"));
      if (dmarc) {
        const p = /p=([a-z]+)/i.exec(dmarc)?.[1] ?? "present";
        facts["DMARC"] = p;
        state["dmarc"] = p;
      }
    } catch { /* none */ }

    if (!resolvedAnything && !Object.keys(state).length) {
      // Total DNS failure (or a parked/no-mail domain): report, and DON'T touch stored state —
      // a transient resolver hiccup must never fabricate "tool removed" diffs. And no-flag: for the
      // same reason: a resolver that answered nothing has not established that they run no tools.
      return { facts: Object.keys(facts).length ? facts : { DNS: "no MX/SPF records found" }, signals: [] };
    }

    const signals: SignalDraft[] = [];
    if (prior.size > 0) { // not the baseline scan → diff
      const day = new Date().toISOString().slice(0, 10);
      if (state["mx"] && prior.get("mx") && prior.get("mx") !== state["mx"]) {
        signals.push({
          dedupKey: `dns-mx-changed:${domain}:${state["mx"]}:${day}`, type: "dns-mx-changed",
          title: `Email provider switched: ${prior.get("mx")} → ${state["mx"]}`,
          detail: { from: prior.get("mx"), to: state["mx"] },
        });
      }
      for (const key of Object.keys(state)) {
        if (key.startsWith("spf:") && !prior.has(key)) {
          const tool = key.slice(4);
          signals.push({
            // Month suffix so a RE-AUTHORIZED tool fires again — a company that drops Outreach and
            // later re-adds it is exactly the buying signal this producer exists for, and keyed on
            // (domain, tool) alone it was silent forever (dedup is permanent, signals are never
            // purged). Same trap atsSwitch.ts:41 documents; `dns-tool-removed` below already had the
            // month. Gated by the `!prior.has(key)` state diff above, so a stable tool cannot re-fire.
            dedupKey: `dns-tool-added:${domain}:${tool}:${new Date().toISOString().slice(0, 7)}`, type: "dns-tool-added",
            title: `New sending tool authorized: ${tool}`, detail: { tool, source: "SPF include" },
          });
        }
      }
      for (const key of prior.keys()) {
        if (key.startsWith("spf:") && !(key in state)) {
          const tool = key.slice(4);
          signals.push({
            dedupKey: `dns-tool-removed:${domain}:${tool}:${new Date().toISOString().slice(0, 7)}`, type: "dns-tool-removed",
            title: `Sending tool removed: ${tool} — possible churn`, detail: { tool, source: "SPF include" },
          });
        }
      }
    }
    if (!ctx.readonly) dbReplaceDomainState(domain, "dns", state); // readonly probe: don't consume the diff baseline
    // No `flag` was returned from ANY exit, so dbSetDomainFlag was never called for "dns"
    // (signals/index.ts writes only `if (out.flag)`). Measured on the live data: 1,018 domains had a
    // dns baseline and ZERO had a dns flag. The UI's PRODUCER_LABELS promises an "Email tools" chip
    // in the Companies "Why now" column and in the current-signals fallback feed — a label for a chip
    // that could not physically render. Same defect techStack.ts carried, found the same way (state
    // rows with no matching flag rows), and it was present in three producers at once.
    //
    // The flag is the TOOLS, not merely "has DNS": every domain has MX records, so `hit` on that
    // would be true everywhere and useless as a filter. A third-party sending tool in SPF is the
    // discriminating fact and the one a seller acts on.
    const tools = Object.keys(state).filter((k) => k.startsWith("spf:")).map((k) => k.slice(4));
    return { facts, signals,
      flag: { hit: tools.length > 0,
        summary: tools.length
          ? `${tools.slice(0, 3).join(", ")}${tools.length > 3 ? ` +${tools.length - 3} more` : ""}`
          : (facts["Email provider"] ? `${facts["Email provider"]}, no third-party sending tools` : "no sending tools detected") } };
  },
};
