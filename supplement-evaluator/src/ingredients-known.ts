// Reference list of real, identifiable supplement ingredients, used only by
// the recognition pre-check in items.ts (red-team #4). It is NOT the
// suggestion allowlist — that stays the curated public/catalog.json — and
// matching it says nothing about evidence quality. catalog.json names/aliases
// and hazards.ts names are recognized too, so they needn't be repeated here.
// Not exhaustive: an unlisted item is only flagged for the model to check, not
// rejected. Add plain ingredient names (never brands), lowercase.
export const KNOWN_INGREDIENTS: string[] = [
  // Vitamins and forms
  "vitamin a", "retinol", "retinyl palmitate", "beta-carotene", "vitamin b1", "thiamine", "benfotiamine",
  "vitamin b2", "riboflavin", "vitamin b3", "niacin", "niacinamide", "nicotinamide", "nicotinamide riboside",
  "nicotinamide mononucleotide", "nmn", "vitamin b5", "pantothenic acid", "vitamin b6", "pyridoxine", "p5p",
  "pyridoxal 5 phosphate", "vitamin b7", "biotin", "hydroxocobalamin", "adenosylcobalamin", "folinic acid",
  "vitamin d2", "ergocalciferol", "vitamin e", "tocopherol", "tocotrienols", "vitamin k", "vitamin k1",
  "phylloquinone", "mk-4", "choline", "choline bitartrate", "alpha-gpc", "citicoline", "cdp-choline", "inositol",
  "myo-inositol", "paba",
  // Minerals and forms
  "magnesium", "magnesium oxide", "magnesium l-threonate", "magnesium malate", "magnesium taurate",
  "magnesium chloride", "magnesium sulfate", "epsom salt", "potassium", "potassium citrate", "potassium chloride",
  "sodium", "electrolytes", "selenium", "selenomethionine", "chromium", "chromium picolinate", "copper",
  "manganese", "molybdenum", "boron", "silica", "silicon", "vanadium", "lithium orotate", "strontium",
  "calcium hmb", "zinc citrate", "zinc oxide", "zinc carnosine", "iron polysaccharide", "heme iron",
  "ferric maltol", "ferrous gluconate", "ferrous fumarate", "iodide", "kelp", "phosphorus", "trace minerals",
  // Amino acids and derivatives
  "l-arginine", "arginine", "l-carnitine", "acetyl-l-carnitine", "alcar", "l-carnitine l-tartrate", "carnitine",
  "l-tyrosine", "tyrosine", "n-acetyl l-tyrosine", "l-tryptophan", "tryptophan", "taurine", "l-lysine", "lysine",
  "l-leucine", "leucine", "isoleucine", "valine", "eaas", "essential amino acids", "l-methionine", "methionine",
  "l-cysteine", "n-acetylcysteine", "nac", "glutathione", "l-glutathione", "l-ornithine", "ornithine",
  "l-histidine", "histidine", "l-serine", "serine", "phosphatidylserine", "l-proline", "proline", "betaine",
  "trimethylglycine", "tmg", "carnosine", "l-carnosine", "anserine", "agmatine", "dmae", "sam-e",
  "s-adenosylmethionine", "gaba", "phenibut", "creatine hcl", "creatine ethyl ester", "citrulline malate",
  "d-aspartic acid", "d-ribose", "ribose",
  // Fatty acids and lipids
  "krill oil", "cod liver oil", "flaxseed oil", "flaxseed", "chia seed", "ala", "epa", "dha", "evening primrose oil",
  "borage oil", "black currant seed oil", "gla", "cla", "conjugated linoleic acid", "mct oil", "mcts",
  "medium chain triglycerides", "coconut oil", "olive leaf extract", "phosphatidylcholine", "lecithin",
  "sunflower lecithin", "omega 7", "sea buckthorn oil", "plant sterols", "phytosterols", "policosanol",
  // Proteins, carbs, fiber
  "pea protein", "soy protein", "rice protein", "hemp protein", "egg white protein", "beef protein",
  "collagen", "gelatin", "colostrum", "lactoferrin", "maltodextrin", "dextrose", "cyclic dextrin",
  "highly branched cyclic dextrin", "waxy maize", "glucomannan", "inulin", "fos", "gos", "acacia fiber",
  "methylcellulose", "wheat dextrin", "oat beta-glucan", "beta-glucan", "partially hydrolyzed guar gum",
  "resistant starch", "chitosan", "apple cider vinegar",
  // Gut
  "lactobacillus", "bifidobacterium", "lactobacillus rhamnosus", "lactobacillus acidophilus",
  "saccharomyces boulardii",
  "prebiotics", "synbiotics", "digestive enzymes", "bromelain", "papain", "lactase", "betaine hcl", "ox bile",
  "slippery elm", "marshmallow root", "deglycyrrhizinated licorice", "dgl", "peppermint oil", "activated charcoal",
  // Herbs and botanicals
  "echinacea", "elderberry", "garlic", "aged garlic extract", "allicin", "ginseng", "panax ginseng",
  "american ginseng", "siberian ginseng", "eleuthero", "maca", "tongkat ali", "eurycoma longifolia",
  "fenugreek", "fadogia agrestis", "horny goat weed", "icariin", "yohimbine", "yohimbe", "tribulus",
  "stinging nettle", "nettle root", "pygeum", "pumpkin seed oil", "black cohosh", "red clover", "dong quai",
  "vitex", "chasteberry", "st john's wort", "kava", "passionflower", "lemon balm", "chamomile", "lavender",
  "hops", "california poppy", "skullcap", "holy basil", "tulsi", "bacopa", "bacopa monnieri", "gotu kola",
  "lion's mane", "cordyceps", "reishi", "chaga", "turkey tail", "shiitake", "maitake", "mushroom extract",
  "milk thistle", "silymarin", "dandelion root", "artichoke extract", "burdock root", "licorice root",
  "boswellia", "frankincense", "white willow bark", "devil's claw", "cat's claw", "capsaicin", "cayenne",
  "black pepper extract", "piperine", "cinnamon", "ceylon cinnamon", "gymnema", "gymnema sylvestre",
  "bitter melon", "banaba", "fenugreek seed", "garcinia cambogia", "hydroxycitric acid", "green coffee bean extract",
  "raspberry ketones", "forskolin", "coleus forskohlii", "yerba mate", "guarana", "kola nut", "cocoa flavanols",
  "cacao", "matcha", "green tea", "black tea extract", "grape seed extract", "pine bark extract", "resveratrol",
  "pterostilbene", "quercetin", "rutin", "hesperidin", "diosmin", "fisetin", "apigenin", "luteolin",
  "spermidine", "sulforaphane", "broccoli sprout extract", "diindolylmethane", "indole-3-carbinol",
  "lutein", "zeaxanthin", "astaxanthin", "lycopene", "bilberry", "cranberry extract", "d-mannose", "saffron",
  "rosemary extract", "oregano oil", "tea tree oil", "neem", "moringa", "spirulina", "chlorella", "wheatgrass",
  "barley grass", "sea moss", "irish moss", "bladderwrack", "fucoidan", "amla", "triphala", "shatavari",
  "guggul", "mucuna pruriens", "l-dopa", "kratom", "kanna", "rhodiola", "schisandra", "astragalus", "andrographis",
  "pelargonium", "goldenseal", "olive leaf", "horse chestnut", "butterbur", "feverfew", "valerian", "ginkgo",
  "huperzine a", "vinpocetine", "noopept", "piracetam", "sceletium",
  // Other common compounds
  "alpha-lipoic acid", "r-lipoic acid", "pqq", "pyrroloquinoline quinone", "nad+", "ubiquinol",
  "idebenone", "l-theanine", "5-htp", "tyramine", "dhea", "pregnenolone", "melatonin", "msm",
  "methylsulfonylmethane", "chondroitin", "hyaluronic acid", "type ii collagen", "undenatured type ii collagen",
  "eggshell membrane", "keratin", "glucosamine hcl", "nattokinase", "serrapeptase", "lumbrokinase",
  "red yeast rice", "bergamot", "citrus bergamot", "berberine hcl",
  "dihydroberberine", "inositol hexaphosphate", "ip6", "calcium d-glucarate", "chlorophyll", "chlorophyllin",
  "bee pollen", "royal jelly", "propolis", "manuka honey", "shilajit", "fulvic acid", "humic acid",
  "turkesterone", "ecdysterone", "ecdysteroids", "bpc-157", "tb-500", "ostarine", "sarms", "ketone esters",
  "exogenous ketones", "beta-hydroxybutyrate", "bhb", "caffeine citrate", "theacrine", "dynamine", "paraxanthine",
  "synephrine", "bitter orange", "hordenine", "octopamine", "l-citrulline dl-malate", "nitrates", "sodium nitrate",
  "sodium citrate", "sodium phosphate", "glycerol", "tart cherry extract", "pomegranate extract", "urolithin a",
  "ergothioneine", "creatinol-o-phosphate", "alpha-ketoglutarate", "calcium alpha-ketoglutarate", "akg", "metformin",
  "ashwagandha extract", "black seed oil", "nigella sativa", "cbd", "cannabidiol",
  "hemp extract", "ginger extract", "garlic extract", "whey protein hydrolysate", "egg protein", "casein hydrolysate",
];
