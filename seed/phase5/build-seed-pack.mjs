/**
 * Build the Phase 5.1 demo seed pack.
 *
 * WHY THIS EXISTS
 *
 * Phase 5 shipped a pack with 12 profiles and 10 posts. That is enough to prove
 * the schema works and nowhere near enough to make a feed feel alive: a student
 * scrolling "For You" hit the bottom of the corpus in one screen, and neither
 * demo corridor had anything to show.
 *
 * The content below is authored here rather than hand-edited into the JSON so
 * that the two things that actually matter stay reviewable in one place:
 *
 *   1. Every synthetic caption is written to be *experience*, not fact. Nothing
 *      here states an administrative rule — visa terms, fees, enrolment steps —
 *      because those belong to the Greenbook and carry a source and a freshness
 *      date. A demo post saying "the health centre needs an appointment" would be
 *      an unsourced administrative claim wearing a student's face.
 *
 *   2. Every anchor name is the *exact* OpenStreetMap name of a real place near
 *      the campus, so `matchOsm` in seed.mjs resolves it to a real coordinate
 *      instead of falling through to a geocoder that might land in another city.
 *      The names were read out of `docs/evidence/phase5/osm-bootstrap.json`, not
 *      invented, and a name that fails to resolve is reported by the seed run.
 *
 * Anchors deliberately carry no `address`. The OSM row supplies the coordinate;
 * a street address typed from memory would be displayed on the place sheet with
 * the same authority as the verified name and could simply be wrong.
 *
 * Usage:
 *   node seed/phase5/build-seed-pack.mjs
 *   node seed/phase5/build-seed-pack.mjs --check    # fail if the pack is stale
 */
import { readFileSync, writeFileSync } from "node:fs";

const PACK = "seed/phase5/yapyep_phase5_seed_pack.json";
const MANIFEST = "seed/phase5/yapyep_phase5_media_manifest.json";
const checkOnly = process.argv.includes("--check");

/* ------------------------------------------------------------------ *
 * 1. Anchors
 * ------------------------------------------------------------------ */

/*
 * Anchors whose Phase 5 name was not the name of a real nearby place.
 *
 * The Phase 5 pack named several anchors from memory ("TOMORO COFFEE (NUS)",
 * "Makan Malah @ NUS", "University of Indonesia Library"). None of those exist in
 * the OpenStreetMap data for their campus, so every seed run fell through to
 * Nominatim — a geocoder asked for a name that is not real, which is precisely how
 * a plausible coordinate for the wrong building gets accepted. Two consequences
 * showed up immediately: the run aborted on a transient `ECONNRESET` from
 * Nominatim, and MY/ID posts kept losing their map link when the fallback also
 * failed.
 *
 * Each replacement below is the exact OSM name of a real place inside the same
 * campus radius and of a compatible category, so `matchOsm` resolves it at score
 * 1050 and the seed never needs the network for an anchor at all.
 */
const ANCHOR_NAME_FIXES = {
  sg_nus_library: "Central Library",
  sg_nus_coffee: "Nami Café",
  sg_nus_food: "The Deck",
  sg_nus_health: "University Health Centre",
  my_um_library: "Perpustakaan Utama",
  my_um_study24: "Perpustakaan Peringatan Za'ba",
  my_um_bank: "RHB Bank",
  id_ui_library: "Perpustakaan Pusat UI",
  id_ui_clinic: "Klinik Satelit UI",
  id_ui_coffee: "Bikun Coffee",
  id_ui_food: "Kantin FT UI",
  id_ui_transport: "Shelter Stasiun UI",
};

const NEW_ANCHORS = [
  /* --- Singapore / NUS --- */
  { id: "sg_nus_study2", country: "SG", campus_id: "campus_nus", name: "Medicine+Science Library", category: "study" },
  { id: "sg_nus_lib2", country: "SG", campus_id: "campus_nus", name: "Hon Sui Sen Memorial Library", category: "study" },
  { id: "sg_nus_food2", country: "SG", campus_id: "campus_nus", name: "Techno Edge Canteen", category: "food" },
  { id: "sg_nus_hawker", country: "SG", campus_id: "campus_nus", name: "Fong Seng Nasi Lemak", category: "food" },
  { id: "sg_nus_museum", country: "SG", campus_id: "campus_nus", name: "NUS Museum", category: "culture" },
  { id: "sg_nus_culture", country: "SG", campus_id: "campus_nus", name: "Lee Kong Chian Natural History Museum", category: "culture" },
  { id: "sg_nus_transport", country: "SG", campus_id: "campus_nus", name: "Prince George's Park Terminal", category: "transport" },
  { id: "sg_nus_sports", country: "SG", campus_id: "campus_nus", name: "Training Pool", category: "studentlife" },
  { id: "sg_nus_hangout", country: "SG", campus_id: "campus_nus", name: "Bar Bar Black Sheep", category: "hangout" },

  /* --- Vietnam / FPT Ho Chi Minh City --- */
  { id: "vn_fpt_campus", country: "VN", campus_id: "campus_fpt", name: "Trường Đại Học FPT Thành phố Hồ Chí Minh", category: "campus" },
  { id: "vn_fpt_coffee", country: "VN", campus_id: "campus_fpt", name: "Cà Phê iCoffee", category: "coffee" },
  { id: "vn_fpt_coffee2", country: "VN", campus_id: "campus_fpt", name: "Góc chill cafe", category: "coffee" },
  { id: "vn_fpt_cafe3", country: "VN", campus_id: "campus_fpt", name: "Highlands Coffee", category: "coffee" },
  { id: "vn_fpt_mixue", country: "VN", campus_id: "campus_fpt", name: "Mixue - 320 Nguyễn Văn Tăng", category: "coffee" },
  { id: "vn_fpt_food", country: "VN", campus_id: "campus_fpt", name: "Phở Gánh 2", category: "food" },
  { id: "vn_fpt_food2", country: "VN", campus_id: "campus_fpt", name: "Bún Bò Phú Lộc", category: "food" },
  { id: "vn_fpt_food3", country: "VN", campus_id: "campus_fpt", name: "Cơm tấm Út Thương 3", category: "food" },
  { id: "vn_fpt_food4", country: "VN", campus_id: "campus_fpt", name: "Hủ tiếu Mỹ Tho", category: "food" },
  { id: "vn_fpt_market", country: "VN", campus_id: "campus_fpt", name: "Chợ Tăng Nhơn Phú", category: "food" },
  { id: "vn_fpt_pharmacy", country: "VN", campus_id: "campus_fpt", name: "Nhà thuốc Long Châu", category: "pharmacy" },
  { id: "vn_fpt_hospital", country: "VN", campus_id: "campus_fpt", name: "Bệnh viện Lê Văn Việt", category: "health" },
  { id: "vn_fpt_bank", country: "VN", campus_id: "campus_fpt", name: "Sacombank", category: "banking" },
  { id: "vn_fpt_transport", country: "VN", campus_id: "campus_fpt", name: "Saigon Petro", category: "transport" },
  { id: "vn_fpt_hangout", country: "VN", campus_id: "campus_fpt", name: "Quán Nhậu Hải Thành", category: "hangout" },
];

/* ------------------------------------------------------------------ *
 * 2. Profiles
 * ------------------------------------------------------------------ */

/*
 * Interests are written in the same words the onboarding chips use ("Coffee",
 * "Food", "Photography"), because the ranker matches a post's topics against
 * these strings and a private vocabulary here would make the demo's
 * "Matches your … interest" reason unreachable.
 *
 * `home_country === host_country` marks a local student; the seed derives the
 * role from that comparison, so no role is asserted here.
 */
const NEW_PROFILES = [
  /* --- Vietnam → Singapore / NUS --- */
  { id: "seed_linh", display_name: "Linh", home_country: "VN", host_country: "SG", university: "NUS", major: "Business Analytics", interests: ["Food", "Coffee", "Travel"], languages: ["vi", "en"] },
  { id: "seed_duc", display_name: "Duc", home_country: "VN", host_country: "SG", university: "NUS", major: "Computer Science", interests: ["AI", "Coffee", "Gaming"], languages: ["vi", "en"] },
  { id: "seed_nga", display_name: "Nga", home_country: "VN", host_country: "SG", university: "NUS", major: "Architecture", interests: ["Photography", "Film", "Coffee"], languages: ["vi", "en"] },
  { id: "seed_thao", display_name: "Thao", home_country: "VN", host_country: "SG", university: "NUS", major: "Life Sciences", interests: ["Food", "Photography", "Travel"], languages: ["vi", "en"] },
  { id: "seed_hieu", display_name: "Hieu", home_country: "VN", host_country: "SG", university: "NUS", major: "Data Science", interests: ["AI", "Football", "Food"], languages: ["vi", "en"] },
  { id: "seed_vy", display_name: "Vy", home_country: "VN", host_country: "SG", university: "NUS", major: "Communications", interests: ["Film", "Music", "Coffee"], languages: ["vi", "en"] },
  { id: "seed_tuan", display_name: "Tuan", home_country: "VN", host_country: "SG", university: "NUS", major: "Electrical Engineering", interests: ["Startups", "Music", "Gaming"], languages: ["vi", "en"] },
  { id: "seed_binh", display_name: "Binh", home_country: "VN", host_country: "SG", university: "NUS", major: "Civil Engineering", interests: ["Travel", "Photography", "Coffee"], languages: ["vi", "en"] },

  /* --- Singapore → Vietnam / FPT Ho Chi Minh City --- */
  { id: "seed_weiming", display_name: "Wei Ming", home_country: "SG", host_country: "VN", university: "FPT", major: "Software Engineering", interests: ["Food", "Photography", "Travel"], languages: ["en", "vi"] },
  { id: "seed_huiying", display_name: "Hui Ying", home_country: "SG", host_country: "VN", university: "FPT", major: "Business", interests: ["Food", "Travel", "Fashion"], languages: ["en", "zh", "vi"] },
  { id: "seed_junhao", display_name: "Jun Hao", home_country: "SG", host_country: "VN", university: "FPT", major: "Artificial Intelligence", interests: ["AI", "Coffee", "Gaming"], languages: ["en", "vi"] },
  { id: "seed_shafiq", display_name: "Shafiq", home_country: "SG", host_country: "VN", university: "FPT", major: "Information Systems", interests: ["Football", "Food", "Music"], languages: ["en", "ms", "vi"] },
  { id: "seed_priya", display_name: "Priya", home_country: "SG", host_country: "VN", university: "FPT", major: "Design", interests: ["Fashion", "Coffee", "Photography"], languages: ["en", "ta", "vi"] },
  { id: "seed_rachel", display_name: "Rachel", home_country: "SG", host_country: "VN", university: "FPT", major: "Finance", interests: ["Food", "Travel", "Film"], languages: ["en", "zh", "vi"] },
  { id: "seed_kelvin", display_name: "Kelvin", home_country: "SG", host_country: "VN", university: "FPT", major: "Cybersecurity", interests: ["Startups", "Football", "Food"], languages: ["en", "vi"] },
  { id: "seed_amelia", display_name: "Amelia", home_country: "SG", host_country: "VN", university: "FPT", major: "Psychology", interests: ["Music", "Coffee", "Film"], languages: ["en", "vi"] },
  { id: "seed_daniel", display_name: "Daniel", home_country: "SG", host_country: "VN", university: "FPT", major: "Mechatronics", interests: ["Startups", "Gaming", "Coffee"], languages: ["en", "vi"] },
  { id: "seed_nadia", display_name: "Nadia", home_country: "SG", host_country: "VN", university: "FPT", major: "Marketing", interests: ["Film", "Food", "Fashion"], languages: ["en", "ms", "vi"] },

  /* --- Local students, one per campus --- */
  { id: "seed_hafiz", display_name: "Hafiz", home_country: "SG", host_country: "SG", university: "NUS", major: "Computer Engineering", interests: ["Food", "Photography", "AI"], languages: ["en", "ms"] },
  { id: "seed_jingyi", display_name: "Jing Yi", home_country: "SG", host_country: "SG", university: "NUS", major: "Pharmacy", interests: ["Food", "Music", "Travel"], languages: ["en", "zh"] },
  { id: "seed_hoang", display_name: "Hoang", home_country: "VN", host_country: "VN", university: "FPT", major: "Software Engineering", interests: ["Gaming", "Coffee", "Football"], languages: ["vi", "en"] },
  { id: "seed_linhchi", display_name: "Linh Chi", home_country: "VN", host_country: "VN", university: "FPT", major: "Business Administration", interests: ["Food", "Fashion", "Music"], languages: ["vi", "en"] },
];

/* ------------------------------------------------------------------ *
 * 3. Posts
 * ------------------------------------------------------------------ */

/*
 * `topics` is what the deterministic enrichment would derive, written out so the
 * seeded corpus ranks exactly as a live one would. The vocabulary is deliberately
 * the same words the onboarding chips use, plus the study/culture/language
 * topics the goals and concerns map onto.
 *
 * `stage` is where the author was in their exchange when they wrote it. It is a
 * derived field in production (never chosen by the author); here it is authored
 * so the corpus spans the timeline instead of clustering in one week.
 */
const NEW_POSTS = [
  /* ------------------------- Singapore / NUS ------------------------- */
  { id: "post_11", author_id: "seed_quang", country: "SG", university: "NUS", type: "study", place_id: "sg_nus_library", stage: "studying", topics: ["study", "library", "quiet"], body: "Booked a group room in the library two days ahead and it changed my whole week. The quiet floors fill up fast after lunch." },
  { id: "post_12", author_id: "seed_aina", country: "SG", university: "NUS", type: "food", place_id: "sg_nus_food", stage: "first_week", topics: ["food", "campus", "routine"], body: "The canteen queue looks terrifying at half past twelve, but it moves. I go at quarter to twelve now and I am done in ten minutes." },
  { id: "post_13", author_id: "seed_rafa", country: "SG", university: "NUS", type: "tip", place_id: "sg_nus_transport", stage: "before_departure", topics: ["travel", "arrival", "advice"], body: "Work out the route to campus before your first 8am. I practised it once on a Sunday and it removed a lot of first-day stress." },
  { id: "post_14", author_id: "seed_mia", country: "SG", university: "NUS", type: "moment", place_id: null, stage: "first_week", topics: ["music", "social", "campus"], body: "First club fair where I actually signed up instead of walking past every table. Easily the best decision of my month." },
  { id: "post_15", author_id: "seed_duc", country: "SG", university: "NUS", type: "place", place_id: "sg_nus_study2", stage: "studying", topics: ["study", "library", "quiet"], body: "This library has power outlets along the whole east wall and almost nobody seems to know. Quiet until about four." },
  { id: "post_16", author_id: "seed_nga", country: "SG", university: "NUS", type: "warning", place_id: "sg_nus_health", stage: "settling_in", topics: ["health", "wellbeing", "advice"], body: "I put off visiting the campus health centre for two weeks because I assumed it would be a hassle. It took twenty minutes and I should have gone sooner." },
  { id: "post_17", author_id: "seed_hafiz", country: "SG", university: "NUS", type: "food", place_id: "sg_nus_hawker", stage: "studying", topics: ["food", "budget", "local"], body: "The hawker food near campus is the real reason I still come back here after class. Ask for less chilli the first time." },
  { id: "post_18", author_id: "seed_nga", country: "SG", university: "NUS", type: "culture", place_id: "sg_nus_museum", stage: "settling_in", topics: ["culture", "campus", "photography"], body: "Spent a whole afternoon in the campus museum and understood this place differently afterwards." },
  { id: "post_19", author_id: "seed_quang", country: "SG", university: "NUS", type: "tip", place_id: "sg_nus_coffee", stage: "studying", topics: ["coffee", "social", "study"], body: "Coffee near campus is a genuine social tool here. I have met more classmates over a drink than in any lecture." },
  { id: "post_20", author_id: "seed_thao", country: "SG", university: "NUS", type: "question", place_id: null, stage: "studying", topics: ["study", "quiet", "advice"], body: "Has anyone found a study spot that stays open late on weekends? The one I use closes earlier than I expected." },
  { id: "post_21", author_id: "seed_jingyi", country: "SG", university: "NUS", type: "study", place_id: null, stage: "studying", topics: ["food", "wellbeing", "social"], body: "Cooking between lab sessions keeps me sane. If you are new, the shared kitchen in hall is friendlier than it looks." },
  { id: "post_22", author_id: "seed_hafiz", country: "SG", university: "NUS", type: "tip", place_id: "sg_nus_food2", stage: "settling_in", topics: ["food", "language", "local"], body: "Learn the dish names before you order. It is a small thing, but people light up when you try." },
  { id: "post_23", author_id: "seed_binh", country: "SG", university: "NUS", type: "place", place_id: "sg_nus_culture", stage: "studying", topics: ["photography", "travel", "wellbeing"], body: "The green trail behind campus is a good reset when the term gets loud. Go early, before the heat." },
  { id: "post_24", author_id: "seed_mia", country: "SG", university: "NUS", type: "moment", place_id: "sg_nus_sports", stage: "settling_in", topics: ["wellbeing", "social", "campus"], body: "The pool at seven in the morning is empty and the light is incredible. I started swimming again just for this." },
  { id: "post_25", author_id: "seed_quang", country: "SG", university: "NUS", type: "guide", place_id: null, stage: "before_departure", topics: ["arrival", "advice", "study"], body: "What I would tell myself before arriving: pick one food place, one study place and one person. Everything else follows from those." },
  { id: "post_26", author_id: "seed_vy", country: "SG", university: "NUS", type: "study", place_id: "sg_nus_lib2", stage: "studying", topics: ["study", "library", "routine"], body: "Library at eight on a Tuesday is the sweet spot. Busy enough to feel focused, quiet enough to actually work." },
  { id: "post_27", author_id: "seed_tuan", country: "SG", university: "NUS", type: "moment", place_id: "sg_nus_hangout", stage: "settling_in", topics: ["music", "social", "coffee"], body: "Found a place near campus that does not feel like a campus bar. Good for talking to people who are not in your course." },

  /* --------------------- Vietnam / FPT Ho Chi Minh City --------------------- */
  { id: "post_28", author_id: "seed_weiming", country: "VN", university: "FPT", type: "food", place_id: "vn_fpt_food", stage: "first_week", topics: ["food", "budget", "local"], body: "First bowl of phở near campus and I understood why people here are particular about it. Cheap, hot, and better than anything I had at home." },
  { id: "post_29", author_id: "seed_huiying", country: "VN", university: "FPT", type: "tip", place_id: "vn_fpt_market", stage: "before_departure", topics: ["language", "food", "budget"], body: "Learn the numbers in Vietnamese before you arrive. It changed how I shop at the market completely." },
  { id: "post_30", author_id: "seed_junhao", country: "VN", university: "FPT", type: "place", place_id: "vn_fpt_coffee2", stage: "studying", topics: ["coffee", "study", "quiet"], body: "Found a cafe ten minutes from campus where nobody rushes you. I do most of my coursework here now." },
  { id: "post_31", author_id: "seed_shafiq", country: "VN", university: "FPT", type: "moment", place_id: null, stage: "settling_in", topics: ["travel", "culture", "social"], body: "Rode a motorbike through the city for the first time. Terrifying for ten minutes, then genuinely fun." },
  { id: "post_32", author_id: "seed_priya", country: "VN", university: "FPT", type: "place", place_id: "vn_fpt_coffee", stage: "studying", topics: ["coffee", "study", "quiet"], body: "This cafe has a second floor that is basically a quiet studio. Cheap, air-conditioned, and the staff leave you alone." },
  { id: "post_33", author_id: "seed_rachel", country: "VN", university: "FPT", type: "food", place_id: "vn_fpt_food2", stage: "studying", topics: ["food", "budget", "local"], body: "Street food near campus is a full meal for the price of a coffee back home. I eat here three times a week now." },
  { id: "post_34", author_id: "seed_daniel", country: "VN", university: "FPT", type: "study", place_id: "vn_fpt_campus", stage: "studying", topics: ["study", "culture", "social"], body: "Group project culture is different here — people meet in person a lot. Once I stopped suggesting video calls it got much easier." },
  { id: "post_35", author_id: "seed_nadia", country: "VN", university: "FPT", type: "culture", place_id: "vn_fpt_cafe3", stage: "settling_in", topics: ["coffee", "culture", "social"], body: "Coffee here is a social thing, not a caffeine thing. Sitting for two hours over one drink is completely normal." },
  { id: "post_36", author_id: "seed_kelvin", country: "VN", university: "FPT", type: "warning", place_id: null, stage: "first_week", topics: ["travel", "arrival", "culture"], body: "Crossing the road takes practice. Walk at a steady pace, do not stop halfway, and you will be fine." },
  { id: "post_37", author_id: "seed_amelia", country: "VN", university: "FPT", type: "tip", place_id: "vn_fpt_pharmacy", stage: "settling_in", topics: ["health", "language", "advice"], body: "The pharmacy near campus was much easier to use than I expected. I pointed at what I needed and it worked out." },
  { id: "post_38", author_id: "seed_hoang", country: "VN", university: "FPT", type: "food", place_id: "vn_fpt_food3", stage: "studying", topics: ["food", "local", "budget"], body: "Cơm tấm near campus is what I eat when I miss home food, and I am already home. Best breakfast in the area." },
  { id: "post_39", author_id: "seed_linhchi", country: "VN", university: "FPT", type: "tip", place_id: "vn_fpt_market", stage: "studying", topics: ["food", "local", "advice"], body: "If you are new, order whatever the person in front of you ordered. It is the fastest way to find the good stalls." },
  { id: "post_40", author_id: "seed_hoang", country: "VN", university: "FPT", type: "moment", place_id: "vn_fpt_campus", stage: "studying", topics: ["campus", "photography", "local"], body: "Campus at six in the evening, when the motorbikes leave, is my favourite ten minutes of the day." },
  { id: "post_41", author_id: "seed_priya", country: "VN", university: "FPT", type: "culture", place_id: null, stage: "studying", topics: ["study", "culture", "fashion"], body: "Design students here share work constantly. It felt invasive at first; now it is the most useful part of the course." },
  { id: "post_42", author_id: "seed_weiming", country: "VN", university: "FPT", type: "place", place_id: "vn_fpt_food4", stage: "settling_in", topics: ["food", "local", "travel"], body: "This noodle place has been here forever and the owner remembers regulars. Go before eleven or after two." },
  { id: "post_43", author_id: "seed_junhao", country: "VN", university: "FPT", type: "moment", place_id: null, stage: "settling_in", topics: ["travel", "culture", "arrival"], body: "Rainy season caught me completely unprepared. Bought a poncho for next to nothing and now I feel like a local." },
  { id: "post_44", author_id: "seed_huiying", country: "VN", university: "FPT", type: "guide", place_id: null, stage: "before_departure", topics: ["arrival", "advice", "food"], body: "First week here, in order: get a local SIM, take one motorbike ride, find your food place, then start saying yes to things." },
];

/* ------------------------------------------------------------------ *
 * 4. Media assignment
 * ------------------------------------------------------------------ */

/*
 * Which asset illustrates which post and place.
 *
 * `map_to` accepts both post ids and place ids, so one photograph can appear on
 * the post that used it and on the place sheet for the place it depicts. A stock
 * photo standing in for two different students' posts would be dishonest, so each
 * asset here is assigned to exactly one post (plus the places it genuinely
 * depicts).
 */
const MEDIA_TARGETS = {
  demo_sg_hawker_centre_glutinous_rice: ["post_17", "sg_nus_hawker"],
  demo_sg_food_court: ["post_12", "sg_nus_food"],
  demo_sg_hawker_market_in_the_tekka_centre_september_2015: ["post_12"],
  demo_sg_customers_at_a_centre_for_food_sellers_or_hawker: ["post_12"],
  demo_sg_chinese_economic_rice: ["post_22", "sg_nus_food2"],
  demo_sg_char_siew_and_roasted_pork_rice: ["post_22"],
  demo_sg_hawker_scene: ["post_17"],
  demo_sg_entrance_e_of_the_national_university_of_singapo: ["post_14", "post_25"],
  demo_sg_kent_ridge_heritage_trail_nus: ["post_23", "sg_nus_culture"],
  demo_sg_nus_centenary_landmark_singapore: ["post_18", "sg_nus_museum"],
  demo_vn_food_stand_in_hu: ["post_28", "vn_fpt_food"],
  demo_vn_b_nh_tr_ng_n_ng_tp_h_ch_minh_street_food_in_ho_c: ["post_33", "vn_fpt_food2"],
  demo_vn_banhcanhcua: ["post_38", "vn_fpt_food3"],
  demo_vn_banh_xeo_restaurant_on_dinh_cong_trang_street_49: ["post_42", "vn_fpt_food4"],
  demo_vn_a_sunday_afternoon_in_a_building_complex_in_ho_c: ["post_39", "vn_fpt_market"],
  demo_vn_a_working_caf_in_ho_chi_minh_city_l_26820367449: ["post_30", "vn_fpt_coffee2"],
  demo_vn_countryside_in_the_heart_of_the_city_freed_after: ["post_31"],
  demo_vn_also_pompous_gates_have_to_be_maintained_also_on: ["post_36"],
  demo_vn_a_very_colorful_troop_in_tan_phu_a_noble_quarter: ["post_40"],
  demo_vn_after_the_rain_in_ho_chi_minh_city_25184032758: ["post_43"],
};

/* ------------------------------------------------------------------ *
 * 5. Build
 * ------------------------------------------------------------------ */

const pack = JSON.parse(readFileSync(PACK, "utf8"));

/**
 * Merge authored entries into a list by id.
 *
 * This script writes the file it also reads. Appending blindly therefore
 * duplicates every entry on the second run — which is exactly what happened the
 * first time it was run twice, and it turned a working pack into one that throws
 * "declared twice". Replacing by id makes the output a pure function of the
 * authored content above: a re-run converges, and editing a caption here updates
 * the existing post instead of adding a second one.
 */
function mergeById(existing, additions, prepare = (entry) => entry) {
  const byId = new Map(existing.map((entry) => [entry.id, entry]));
  const seen = new Set();
  for (const addition of additions) {
    if (seen.has(addition.id)) throw new Error(`${addition.id} is declared twice in this file`);
    seen.add(addition.id);
    byId.set(addition.id, { ...(byId.get(addition.id) ?? {}), ...prepare(addition) });
  }
  return [...byId.values()];
}

const anchors = mergeById(
  pack.poi_seeds.map((anchor) => {
    const fixed = ANCHOR_NAME_FIXES[anchor.id];
    if (!fixed) return anchor;
    /*
     * The stored address belonged to the old name, which was not a real place. It
     * would now be printed on the place sheet next to a different building, with
     * the same authority as the verified name — worse than showing nothing.
     */
    return { ...anchor, name: fixed, address: "" };
  }),
  NEW_ANCHORS,
  (anchor) => ({ verification: "researched_real_poi", geocode_on_seed: true, ...anchor }),
);
const anchorIds = new Set(anchors.map((anchor) => anchor.id));

const profiles = mergeById(pack.community_profiles, NEW_PROFILES, (profile) => ({
  discoverable: true,
  verification: "demo_seed",
  is_demo_seed: true,
  live_location_shared: false,
  ...profile,
}));
const profileIds = new Set(profiles.map((profile) => profile.id));

/*
 * Referential integrity is checked here rather than discovered at seed time. A
 * post pointing at an anchor or an author that does not exist would write a row
 * the feed can never render, and the failure would only surface in the browser.
 */
for (const post of NEW_POSTS) {
  if (!profileIds.has(post.author_id)) throw new Error(`${post.id}: unknown author ${post.author_id}`);
  if (post.place_id && !anchorIds.has(post.place_id)) throw new Error(`${post.id}: unknown place ${post.place_id}`);
}
const posts = mergeById(pack.community_posts, NEW_POSTS, (post) => ({
  visibility: "public_demo",
  is_demo_seed: true,
  verification: "synthetic_demo",
  ...post,
}));
const postIds = new Set(posts.map((post) => post.id));

/*
 * The media manifest is updated in the same pass so an asset can never be
 * assigned to a post that does not exist. Existing assignments are unioned
 * rather than replaced: re-running must not silently detach the Phase 5 images.
 */
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const assetIds = new Set(manifest.assets.map((asset) => asset.id));
for (const [assetId, targets] of Object.entries(MEDIA_TARGETS)) {
  if (!assetIds.has(assetId)) throw new Error(`media asset ${assetId} is not in the manifest`);
  for (const target of targets) {
    if (!postIds.has(target) && !anchorIds.has(target)) throw new Error(`${assetId}: unknown target ${target}`);
  }
}
const assets = manifest.assets.map((asset) => {
  const extra = MEDIA_TARGETS[asset.id];
  if (!extra) return asset;
  return { ...asset, map_to: [...new Set([...(asset.map_to ?? []), ...extra])] };
});

/* Merged by id for the same reason as everything else: this file is re-runnable. */
const campusCenters = mergeById(pack.campus_centers, [
  { id: "campus_fpt", country: "VN", city: "Ho Chi Minh City", university: "FPT University", approx_center: { lat: 10.841436, lng: 106.809857 } },
]);

const nextPack = {
  ...pack,
  meta: {
    ...pack.meta,
    generated_on: new Date().toISOString().slice(0, 10),
    // Deduplicated so re-running does not append the same rule a second time.
    rules: [
      ...new Set([
        ...pack.meta.rules,
        "Phase 5.1 densifies the demo corpus for two corridors: VN→SG/NUS and SG→VN/FPT HCMC.",
        "Synthetic captions describe student experience only. Administrative facts belong to the Greenbook and are never asserted here.",
        "Every anchor name is the exact OpenStreetMap name of a real nearby place; a name that does not resolve is reported, never guessed.",
      ]),
    ],
  },
  campus_centers: campusCenters,
  poi_seeds: anchors,
  community_profiles: profiles,
  community_posts: posts,
};

const serialised = `${JSON.stringify(nextPack, null, 2)}\n`;
const manifestSerialised = `${JSON.stringify({ ...manifest, assets }, null, 2)}\n`;

if (checkOnly) {
  const current = readFileSync(PACK, "utf8");
  const currentManifest = readFileSync(MANIFEST, "utf8");
  if (current !== serialised || currentManifest !== manifestSerialised) {
    console.error("seed pack is stale — run: node seed/phase5/build-seed-pack.mjs");
    process.exit(1);
  }
  console.log("seed pack is up to date");
} else {
  writeFileSync(PACK, serialised);
  writeFileSync(MANIFEST, manifestSerialised);
  const withPlace = posts.filter((post) => post.place_id).length;
  console.log(`anchors:  ${anchors.length}`);
  console.log(`profiles: ${profiles.length}`);
  console.log(`posts:    ${posts.length} (${withPlace} pinned to a place)`);
  console.log(`assets:   ${assets.length} (${assets.filter((asset) => (asset.map_to ?? []).length).length} assigned)`);
  for (const corridor of [
    { label: "SG / NUS", country: "SG" },
    { label: "VN / FPT", country: "VN" },
  ]) {
    const subset = posts.filter((post) => post.country === corridor.country);
    console.log(`  ${corridor.label}: ${subset.length} posts, ${new Set(subset.map((post) => post.author_id)).size} authors`);
  }
}
