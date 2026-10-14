// A starter list of common findings a hospital can import and then edit. These are examples to save typing:
// every hospital's doctors must review the medicines, doses and advice before relying on them.
// dose uses MORNING / DAY / NIGHT (comma separated) or ANYTIME; timing is BEFORE_FOOD, AFTER_FOOD or ANY.
const m = (name, composition, dose, timing, durationDays, note = '') => ({ name, composition, dose, timing, durationDays, note });

export const STARTER_FINDINGS = [
  {
    name: 'Viral fever', group: 'Fever and infections',
    findings: 'Fever with body ache for 2 days. No cough or breathlessness. Throat mildly congested. Chest clear.',
    advice: 'Take plenty of fluids and rest. Review if the fever lasts more than 3 days.',
    medicines: [m('Paracetamol 500 mg tablet', 'Paracetamol (500mg)', 'MORNING,DAY,NIGHT', 'AFTER_FOOD', 3), m('ORS sachet', 'Oral rehydration salts', 'ANYTIME', 'ANY', 3, 'One sachet in a glass of water, sip through the day'), m('Cetirizine 10 mg tablet', 'Cetirizine (10mg)', 'NIGHT', 'AFTER_FOOD', 3)],
  },
  {
    name: 'Common cold', group: 'Fever and infections',
    findings: 'Runny nose and sneezing for 3 days. Throat mildly red. Chest clear.',
    advice: 'Warm fluids, steam inhalation and rest. Review if symptoms worsen.',
    medicines: [m('Cetirizine 10 mg tablet', 'Cetirizine (10mg)', 'NIGHT', 'AFTER_FOOD', 5), m('Paracetamol 500 mg tablet', 'Paracetamol (500mg)', 'MORNING,NIGHT', 'AFTER_FOOD', 3), m('Saline nasal drops', 'Sodium chloride', 'MORNING,NIGHT', 'ANY', 5, '2 drops in each nostril')],
  },
  {
    name: 'Allergic rhinitis', group: 'Chest and allergy',
    findings: 'Repeated sneezing, itchy nose and watery eyes, worse in the morning. Nasal mucosa pale. Chest clear.',
    advice: 'Avoid dust and cold drinks. Review after 1 week.',
    medicines: [m('Cetirizine 10 mg tablet', 'Cetirizine (10mg)', 'NIGHT', 'AFTER_FOOD', 7), m('Saline nasal drops', 'Sodium chloride', 'MORNING,NIGHT', 'ANY', 7, '2 drops in each nostril')],
  },
  {
    name: 'Acidity', group: 'Stomach',
    findings: 'Burning in the upper abdomen after meals with bloating. Abdomen soft, no tenderness.',
    advice: 'Avoid spicy and oily food and late-night meals. Review if pain persists.',
    medicines: [m('Pantoprazole 40 mg tablet', 'Pantoprazole (40mg)', 'MORNING', 'BEFORE_FOOD', 14), m('Antacid gel', 'Aluminium hydroxide, magnesium hydroxide', 'DAY,NIGHT', 'AFTER_FOOD', 7)],
  },
  {
    name: 'Loose motions', group: 'Stomach',
    findings: 'Loose motions 4 to 5 times since yesterday. Mild dehydration. Abdomen soft.',
    advice: 'Drink ORS and plenty of fluids. Eat light food. Review if there is blood in stools, vomiting or high fever.',
    medicines: [m('ORS sachet', 'Oral rehydration salts', 'ANYTIME', 'ANY', 3, 'After each loose motion'), m('Zinc 20 mg tablet', 'Zinc (20mg)', 'MORNING', 'AFTER_FOOD', 10), m('Probiotic capsule', 'Lactobacillus', 'MORNING,NIGHT', 'AFTER_FOOD', 5)],
  },
  {
    name: 'Constipation', group: 'Stomach',
    findings: 'Hard stools with straining for several days. Abdomen soft, no tenderness.',
    advice: 'Eat more fibre, drink plenty of water and walk daily.',
    medicines: [m('Isabgol husk', 'Psyllium husk', 'NIGHT', 'ANY', 7, 'One spoon in a glass of water')],
  },
  {
    name: 'Headache', group: 'Pain',
    findings: 'Headache since morning, no vomiting or neck stiffness. Neurologically normal.',
    advice: 'Rest in a quiet room and drink water. Review if it keeps coming back.',
    medicines: [m('Paracetamol 500 mg tablet', 'Paracetamol (500mg)', 'ANYTIME', 'AFTER_FOOD', 3, 'Only when needed, not more than 3 in a day')],
  },
  {
    name: 'Body ache', group: 'Pain',
    findings: 'Generalised body ache after exertion. No swelling or redness. Movements full.',
    advice: 'Rest and warm compress. Gentle stretching.',
    medicines: [m('Paracetamol 500 mg tablet', 'Paracetamol (500mg)', 'MORNING,NIGHT', 'AFTER_FOOD', 3), m('Diclofenac gel', 'Diclofenac (1%)', 'ANYTIME', 'ANY', 5, 'Apply on the area twice a day')],
  },
  {
    name: 'Skin allergy / itching', group: 'Skin',
    findings: 'Itchy red patches on the skin without discharge. No fever.',
    advice: 'Avoid scratching and the suspected trigger. Review if it spreads.',
    medicines: [m('Cetirizine 10 mg tablet', 'Cetirizine (10mg)', 'NIGHT', 'AFTER_FOOD', 5), m('Calamine lotion', 'Calamine', 'ANYTIME', 'ANY', 5, 'Apply on itchy areas')],
  },
  {
    name: 'Weakness', group: 'General',
    findings: 'Complains of tiredness and weakness. Vitals stable.',
    advice: 'Balanced diet, enough sleep and fluids. Review if it continues.',
    medicines: [m('Multivitamin tablet', 'Multivitamin and minerals', 'MORNING', 'AFTER_FOOD', 30)],
  },
];
