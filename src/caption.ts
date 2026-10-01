import { sha256 } from './security';

const captions = ['مو قادر 😂', 'كل مرة نفس القصة 😂', 'مين كمان هيك؟ 😂', 'ضحكت غصب عني 😂', 'آخر شي كنت متوقعه 😂', 'خلص راحت الهيبة 😂', 'أنا وصاحبي باختصار 😂', 'لسا عم اضحك 😂'];

export async function createCaption(jobId: string): Promise<string> {
  // Deterministic, brief, no paid AI service and no untrusted source-caption copying.
  const seed = parseInt((await sha256(jobId)).slice(0, 8), 16);
  return `${captions[seed % captions.length]}\n\n#ميمز #ضحك #ميمز_عربي #memes #funny #fyp`;
}
