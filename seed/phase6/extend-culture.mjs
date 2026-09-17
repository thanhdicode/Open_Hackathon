/** One-time preparation of explicitly reviewed provenance fixtures; no database writes. */
import { readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
const root = "seed/phase6";
const registry = parse(readFileSync(`${root}/source-registry.yaml`, "utf8"));
const facts = JSON.parse(readFileSync(`${root}/knowledge-facts.json`, "utf8")).filter((f) => f.sourceId !== "p6-la-tourism");
registry.sources = registry.sources.filter((s) => s.id !== "p6-la-tourism");
function add(id, country, agency, definitions, { sourceType = "government", city = null, university = null } = {}) {
  const fetched = JSON.parse(readFileSync(`${root}/${id}-probe.json`, "utf8"));
  if (!fetched.ok) throw new Error(`${id}: source not fetched`);
  const source = { ...registry.sources[0], id, country, url: fetched.url, agency, domain: new URL(fetched.url).hostname, categories: ["culture"], source_type: sourceType, city, university, attribution: agency, licence_url: null, verification_basis: "Named government/official university publisher; ordinary HTTP 200 page inspected. Short exact evidence citations only; source-specific setting retained, no nationality-wide stereotype or invented phrase translation." };
  if (!registry.sources.some((s) => s.id === id)) registry.sources.push(source);
  for (const [claim, evidenceQuote, chapter = "culture_and_people"] of definitions) {
    if (!fetched.text.includes(evidenceQuote)) throw new Error(`${id}: quote absent: ${evidenceQuote.slice(0, 55)}`);
    if (!facts.some((f) => f.sourceId === id && f.evidenceQuote === evidenceQuote)) facts.push({ country, sourceId: id, claim, evidenceQuote, chapter, journeyStage: "ongoing", city, university });
  }
}
add("p6-bn-tourism", "BN", "Brunei Tourism — Tourism Development Department", [
  ["Brunei Tourism advises mosque visitors to observe silence.", "Observe silence."],
  ["For Brunei mosque visits, the tourism guide says some mosques provide robes and shawls.", "Some mosques will provide simple robes and shawls to meet this standard."],
  ["Brunei Tourism advises removing footwear in a mosque.", "DON’T WEAR FOOTWEAR\nin a mosque."],
  ["Brunei Tourism advises waiting for the other person to offer an opposite-sex handshake.", "DON’T SHAKE HANDS\nwith members of the opposite sex, unless offered first by the other person."],
  ["Brunei Tourism advises avoiding loud noises during the call to prayer.", "DON’T MAKE LOUD NOISES\nwhen you hear the azan or the Muslim call to prayer."],
  ["Brunei Tourism describes most shops and eating establishments opening around 9.30 am, with some earlier exceptions.", "Shops and eating establishments generally open around 9.30 am, with selected cafes and convenience stores opening earlier at 7 to 8 am."],
]);
add("p6-bn-ubd", "BN", "Universiti Brunei Darussalam — Health and Welfare", [
  ["At Universiti Brunei Darussalam, Student Affairs oversees welfare and campus student life.", "The Student Affairs Section (SAS) in the university has the overall responsibility of overseeing the welfare and student life on campus.", "study_here"],
  ["UBD's main campus lists a cafeteria and PMUBD Shop as its two eateries.", "In the main campus, there are two eateries available, the UBD cafeteria and a PMUBD Shop.", "student_reality"],
  ["UBD describes individual or group counselling for academic, social and personal matters.", "Conduct counseling session on academic, social and personal matters with students either individually or in group; organizes leadership and life skill courses relevant to the needs of the students.", "study_here"],
  ["UBD's religious and spiritual unit offers activities, community services, guidance and advice to students.", "Organises religious activities and community services, and assists in providing religious and spiritual guidance and advice to students.", "study_here"],
], { sourceType: "university", city: "Bandar Seri Begawan" });
add("p6-kh-culture", "KH", "U.S. International Trade Administration — Cambodia Business Travel", [
  ["For Cambodian business introductions, the U.S. trade guide recommends a prior introduction or personal reference.", "It is recommended that approaches to potential business contacts be made with a prior introduction or personal reference."],
  ["In Cambodian business introductions, the U.S. trade guide recommends exchanging cards with both hands and briefly reading the received card.", "It is recommended to distribute and receive business cards with both hands as a sign of respect and take a few seconds to study a person’s card after it has been received."],
  ["The U.S. Cambodia business guide describes sampeah as a traditional palms-together greeting.", "The “sampeah” – placing palms together in a prayer-like position – remains the traditional gesture of greeting, particularly for women, although it is becoming more popular to shake hands."],
  ["The U.S. Cambodia business guide advises waiting for a woman to offer a handshake, otherwise using sampeah.", "Foreigners may shake hands with men and women but should wait until the woman offers her hand; otherwise, use the traditional sampeah greeting."],
  ["The U.S. trade guide says Khmer is Cambodia's official language and English is commonly used in business meetings.", "Khmer is the official language of Cambodia. English is commonly used in most business meetings.", "speak_and_understand"],
  ["For less formal Cambodian business settings, the U.S. trade guide suggests business casual attire.", "In a less formal setting, business casual attire may be appropriate."],
]);
add("p6-la-culture", "LA", "U.S. International Trade Administration — Laos Business Travel", [
  ["The U.S. Laos business guide describes language diversity alongside Lao as the national language.", "Lao is the national language, though many other languages are spoken by the ethnic groups that make up the Lao population.", "speak_and_understand"],
  ["The U.S. Laos business guide describes Thai as spoken and understood by many Lao speakers.", "Due to the similarity of the Lao and Thai languages, many Lao speak and understand Thai.", "speak_and_understand"],
  ["The U.S. Laos business guide notes basic English among some residents of Vientiane and larger provincial capitals, with limited nationwide use.", "Some Lao residing in Vientiane and the larger provincial capitals speak basic English, although the overall percentage of the population that speaks English is low.", "speak_and_understand"],
  ["The U.S. Laos business guide lists Pii Mai and That Luang Festival among local holidays.", "Local holidays include International Women’s Day, Pii Mai (Lao New Year), International Labor Day, Lao National Day, and the That Luang Festival."],
  ["The U.S. Laos business guide cautions that holiday dates can change shortly beforehand, especially around Lao New Year.", "The Lao government is known to change the effective dates of holidays shortly before they occur, especially around Lao New Year."],
]);
add("p6-mm-tourism", "MM", "Myanmar National Portal — Travel Myanmar (Ministry of Foreign Affairs reference)", [
  ["Myanmar's official travel page describes Mingalabar as a welcome and wish for good fortune.", '"Mingalabar" is a word of welcome as well as a wish for good fortune.', "speak_and_understand"],
]);
add("p6-mm-festivals", "MM", "Myanmar National Portal — Festivals", [
  ["Myanmar's official festival guide describes Kason's principal activity as watering the Bo Tree.", "The main activity on this festival day is pouring water at the Bo Tree."],
  ["In its Kason section, Myanmar's festival guide describes watering the Bo Tree as Buddhist veneration.", "Pouring clean and cool water on the Bo Tree is done as a symbol of veneration to the Buddha who attained Enlightenment by meditating under the Bo Tree."],
  ["Myanmar's festival guide describes Thadingyut Buddhist celebrations with multicoloured illuminations.", "On account of that, Myanmar Buddhists celebrate Tavatimsa Festival on the full-moon day of Thadingyut by lighting multi-coloured illuminations."],
  ["In its Thadingyut section, Myanmar's festival guide describes laypeople paying respect to parents and elders.", "Likewise, there is also the practice among the laity of paying obeisance to parents and elders."],
]);
add("p6-tl-tourism", "TL", "Timor-Leste Ministry of Tourism and Environment — Plan Your Trip", [
  ["Timor-Leste's official tourism guide identifies Tetun and Portuguese as official languages.", "Tetun and Portuguese are official languages.", "speak_and_understand"],
  ["Timor-Leste's tourism guide says Indonesian is widely understood.", "Indonesian is widely understood.", "speak_and_understand"],
  ["Timor-Leste tourism guidance describes English at Dili hotels and tour operators as less common in rural areas.", "English is spoken at hotels and by tour operators in Dili but less common in rural areas.", "speak_and_understand"],
  ["Timor-Leste's tourism guide encourages learning basic Tetun greetings; it lists bondia and obrigadu without supplying translations.", "Learning basic Tetun greetings (bondia, obrigadu) goes a long way.", "speak_and_understand"],
]);
add("p6-tl-culture", "TL", "Timor-Leste Ministry of Tourism and Environment — About Timor-Leste", [
  ["Timor-Leste's official tourism guide describes indigenous language communities with distinct cultural practices.", "The country is home to more than 30 indigenous language groups, each with distinct cultural practices, from the mountainous Mambai heartland to the coastal Fataluku communities in the far east."],
  ["Timor-Leste's official guide describes tais weaving as textiles carrying clan identity, spiritual meaning and regional pride.", "Tais weaving is perhaps the most visible cultural art form: intricate hand-woven textiles that carry clan identity, spiritual meaning, and regional pride."],
  ["Timor-Leste's official guide describes music, dance and oral storytelling as important to community life.", "Music, dance, and oral storytelling remain vital parts of community life."],
]);
add("p6-vn-deep-culture", "VN", "Vietnam National Authority of Tourism — Vietnamese Etiquette for Travellers", [
  ["Vietnam's official tourism guide advises taking shoes off outside the door when entering a family home.", "When you enter someone’s house, take your shoes off just outside the door."],
  ["For family visits, Vietnam Tourism recommends greeting older family members first and using the right hand for handshakes.", "Greet the older members of a family first, shake hands with your right hand and offer plenty of smiles to everyone!"],
  ["Vietnam Tourism describes shared dishes with individual rice bowls and chopsticks as a common meal format.", "Most meals are laid out as an assortment of shared dishes, with small rice bowls and chopsticks for each diner."],
  ["Vietnam Tourism advises passing dishes with both hands or the right hand at shared meals.", "Pass dishes at the table with both hands or your right hand (not the left) and hold your spoon in your left hand if you’re eating soup."],
  ["When offered more food, Vietnam Tourism suggests politely repeating that you are full if you want to stop eating.", "If you want to stop eating, simply repeat politely that you’re very full."],
]);
add("p6-sg-deep-culture", "SG", "National University of Singapore — SP2273 Course Overview", [
  ["In NUS SP2273, the course guide encourages asking questions and seeking clarification during lectures or tutorials.", "Use tutorial or lecture time to ask questions and get clarification.", "study_here"],
  ["NUS SP2273 encourages predicting what changed code will do before running it.", "Before running it, try to predict what will happen.", "study_here"],
  ["NUS SP2273 describes a hands-on format mixing individual and group work.", "This is a hands-on course with a healthy mix of individual and group work.", "study_here"],
  ["NUS SP2273 says students wanting support while learning independently can reach out to an instructor.", "If you need help, you can reach out to an instructor.", "study_here"],
], { sourceType: "university", city: "Singapore" });
add("p6-th-deep-culture", "TH", "U.S. International Trade Administration — Thailand Business Travel", [
  ["The U.S. Thai business guide describes wai as palms together at chest level with a slight bow, expressing greeting and respect.", "The “wai” is a traditional gesture of greeting and respect in Thailand made by placing your palms together in a prayer-like position at chest level and giving a slight bow."],
  ["The U.S. Thai business guide describes Khun followed by a first name or nickname as a form of address.", "“Khun” is the Thai form of address for Mr., Mrs., and Ms. and is followed by a first name or nickname.", "speak_and_understand"],
  ["In Thai business introductions, the U.S. trade guide advises addressing the most senior person first.", "Respect for hierarchy is essential, so it is important to address the most senior person first and be aware of their status."],
  ["The U.S. Thai business guide advises avoiding writing on someone's business card in their presence.", "It is considered impolite to write on someone’s business card in their presence, so avoid writing notes on cards handed to you during a meeting or event."],
]);
add("p6-my-deep-culture", "MY", "Universiti Malaya — Study FAQs and Information", [
  ["Universiti Malaya's study FAQ says candidates must attend teaching, learning and research activities related to their study programme.", "It is compulsory for all candidates to attend all teaching and learning activities , as well research activities, related to their program of study.", "study_here"],
  ["UM's study FAQ says candidates unable to attend learning activities should immediately inform the lecturer with a valid reason and supporting documents.", "If a candidate is unable to attend any teaching and learning activities, they must immediately inform the lecturer, providing a valid reason for their absence along with relevant supporting documents", "study_here"],
  ["UM's study FAQ says lecturers explain absence consequences and record attendance and notification.", "The lecturer will inform the candidate about the consequences of being absent and will maintain records of the notification and class attendance", "study_here"],
], { sourceType: "university", city: "Kuala Lumpur" });
add("p6-id-deep-culture", "ID", "U.S. International Trade Administration — Indonesia Business Travel", [
  ["The U.S. Indonesia business guide advises waiting for the host's invitation before drinking at a business meeting.", "It is customary not to drink until the host invites you to do so, often at the end of the meeting."],
  ["The U.S. Indonesia business guide advises giving and receiving items with the right hand.", "Always use your right hand for giving and receiving items, as the left hand is considered impolite for such gestures."],
  ["The U.S. Indonesia business guide advises avoiding pointing shoe soles toward others while seated.", "When sitting, avoid pointing the soles of your shoes toward others."],
  ["The U.S. Indonesia business guide advises attentive listening, noticing nonverbal cues and written clarification.", "U.S. businesspeople should listen attentively, watch for non-verbal cues, and follow up in writing for clarity."],
  ["The U.S. Indonesia business guide describes long-sleeved batik as formal and short sleeves as more casual in government and corporate settings.", "The batik shirt is widely accepted in government and corporate settings; long-sleeved batik is considered formal, while short-sleeved versions are viewed as more casual."],
]);
add("p6-ph-deep-culture", "PH", "University of the Philippines Diliman — Asian Center IT Policy and University Rules", [
  ["UP Diliman's Asian Center privacy guidance says classmates' email access is for class-related communication.", "All students have legitimate access at least to their classmates’ UP Mail/DILNET email addresses to facilitate communication only on class-related matters (e.g. groupwork).", "study_here"],
  ["UP Diliman's Asian Center asks students not to reshare or reupload classmates' or professors' Google Drive files without permission.", "Please do not reshare or reupload files shared to you via Google Drive without permission from your classmate and/or professor.", "study_here"],
  ["UP Diliman's Asian Center asks students not to post class or classmate screenshots on social media without consent.", "Please do not post screenshots of your class or your classmates on social media, again without their consent.", "study_here"],
  ["UP Diliman's posted online-meeting guidelines advise muting microphones when not speaking.", "1. DO mute your microphone when you are not speaking to eliminate background noise and prevent disruptions during your meetings, conferences, or classes.", "study_here"],
  ["UP Diliman's posted Zoom guidelines advise raising a hand and speaking when recognised by the facilitator rather than crosstalking.", "4. DO NOT crosstalk. Use the Zoom feature for raising a hand (or show your physical hand in front of your camera) and speak only when recognized by the meeting host or facilitator.", "study_here"],
], { sourceType: "university", city: "Quezon City" });
writeFileSync(`${root}/source-registry.yaml`, stringify(registry));
writeFileSync(`${root}/knowledge-facts.json`, JSON.stringify(facts, null, 2));
console.log(`${facts.length} total fixture facts; ${registry.sources.length} sources.`);
