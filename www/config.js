/* Public Iron Atlas configuration. The browser previews the product. Native builds require store configuration for paid access. */
window.IRON_ATLAS_CONFIG = {
  // Accounts and cloud backup (Supabase): Project settings > API
  supabaseUrl: 'https://ljfycdfhnkwhvzxyqsxo.supabase.co',            // e.g. 'https://abcdefghijkl.supabase.co'
  supabaseAnonKey: 'sb_publishable_T1WGMi7yLMZrhuRI7BT2lg_NazYwE56',        // the anon public key, never the service_role key
  passwordResetUrl: 'https://ironatlas.insomnia-it.co.uk/account/',

  // Premium subscriptions (RevenueCat): Project settings > API keys > public app-specific keys
  revenuecatAppleKey: 'appl_rybHPfDjWWIunGANpMsLUoRdUeD',     // starts appl_
  revenuecatGoogleKey: 'goog_PRoJlPwPaJXiuxEYAXvzDTEsGsc',    // public Google Play SDK key
  entitlement: 'premium',     // the entitlement your three products unlock
  coachEntitlement: 'coach',  // Iron Atlas Coach for personal trainers
  coachOffering: 'coach',     // the RevenueCat offering that holds the two Coach packages
  // Browser-preview prices only. Native purchases display prices returned by the store.
  prices: { monthly: '£4.99', annual: '£29.99', lifetime: '£59.99', annualMonthly: '£2.50', coachMonthly: '£14.99', coachAnnual: '£149.99' },
  termsUrl: 'https://ironatlas.insomnia-it.co.uk/terms/',               // required by Apple on the subscription screen, e.g. 'https://www.insomnia-it.co.uk/iron-atlas/terms'
  privacyUrl: 'https://ironatlas.insomnia-it.co.uk/privacy/',             // e.g. 'https://www.insomnia-it.co.uk/iron-atlas/privacy'

  // Gym edition: a gym's own name, colours and logo. Remove `brand` for the standard app.
  // brand: {
  //   name: 'Riverside Gym',
  //   colors: ['#00C2A8', '#1E6BFF'],   // two colours for buttons and highlights
  //   logo: 'gym-logo.png',             // a square image placed next to index.html in www/
  //   unlockAll: true,                  // members get every Premium feature without a subscription
  //   poweredBy: true,                  // show "with Iron Atlas" under the gym's name
  // },
};
