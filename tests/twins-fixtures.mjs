// Fixtures for tests/twins.test.mjs: real TCGdex records (fetched
// 2026-10-01 by the research, /tmp/twins), trimmed to the fields the matcher
// reads. ENGLISH holds each case's best ranked English candidates (enough for
// the margin and the ties), plus, for M6-001, every English print of its
// species, to show the window leaving them all out. research is what
// match2.py answered for the card on its full data, aligned the English sets
// it learned for the Japanese set.
//
// English cards carry setId, setDate, official, and setName the way
// js/twins.js adds them from the set list.

export const CASES = {
	"M4-001": {
		"aligned": [
			"me04"
		],
		"record": {
			"id": "M4-001",
			"localId": "001",
			"name": "ビードル",
			"category": "Pokemon",
			"dexId": [
				13
			],
			"hp": 50,
			"illustrator": "sowsow",
			"rarity": "Common",
			"attacks": [
				{
					"cost": [
						"Grass"
					],
					"damage": 30
				}
			],
			"set": {
				"id": "M4",
				"cardCount": {
					"official": 83
				}
			}
		},
		"research": {
			"ranked": [
				"me04-001"
			],
			"top": "me04-001",
			"verdict": "one"
		},
		"setDate": "2026-03-13"
	},
	"S11-057": {
		"aligned": [
			"swsh11",
			"swsh12"
		],
		"record": {
			"id": "S11-057",
			"localId": "057",
			"name": "プテラVSTAR",
			"category": "Pokemon",
			"dexId": [
				142
			],
			"hp": 260,
			"illustrator": "5ban Graphics",
			"rarity": "Triple Rare",
			"attacks": [
				{
					"cost": [
						"Fighting",
						"Colorless",
						"Colorless"
					],
					"damage": 240
				},
				{
					"cost": [
						"Colorless"
					],
					"damage": null
				}
			],
			"set": {
				"id": "S11",
				"cardCount": {
					"official": 100
				}
			}
		},
		"research": {
			"ranked": [
				"swsh11-093",
				"swsh11-199"
			],
			"top": "swsh11-093",
			"verdict": "one"
		},
		"setDate": "2022-07-15"
	},
	"S11-118": {
		"aligned": [
			"swsh11",
			"swsh12"
		],
		"record": {
			"id": "S11-118",
			"localId": "118",
			"name": "プテラVSTAR",
			"category": "Pokemon",
			"dexId": [
				142
			],
			"hp": 260,
			"illustrator": "5ban Graphics",
			"rarity": "Holo Rare",
			"attacks": [
				{
					"cost": [
						"Fighting",
						"Colorless",
						"Colorless"
					],
					"damage": 240
				},
				{
					"cost": [
						"Colorless"
					],
					"damage": null
				}
			],
			"set": {
				"id": "S11",
				"cardCount": {
					"official": 100
				}
			}
		},
		"research": {
			"ranked": [
				"swsh11-199",
				"swsh11-093"
			],
			"top": "swsh11-199",
			"verdict": "one"
		},
		"setDate": "2022-07-15"
	},
	"M4-107": {
		"aligned": [
			"me04"
		],
		"record": {
			"id": "M4-107",
			"localId": "107",
			"name": "ツールスクラッパー",
			"category": "Trainer",
			"illustrator": "Studio Bora Inc.",
			"effect": "おたがいの場のポケモンについている「ポケモンのどうぐ」を2枚まで選び、トラッシュする。",
			"trainerType": "Item",
			"rarity": "Ultra Rare",
			"attacks": [],
			"set": {
				"id": "M4",
				"cardCount": {
					"official": 83
				}
			}
		},
		"research": {
			"ranked": [
				"me04-115",
				"me04-108",
				"me02.5-264",
				"me02.5-212",
				"me04-113",
				"me03-113",
				"me05-107",
				"me03-117"
			],
			"top": "me04-115",
			"verdict": "one"
		},
		"setDate": "2026-03-13"
	},
	"M6-001": {
		"aligned": [],
		"record": {
			"id": "M6-001",
			"localId": "001",
			"name": "ヘラクロス",
			"category": "Pokemon",
			"dexId": [
				214
			],
			"hp": 130,
			"illustrator": "Satoshi Ito",
			"rarity": "Common",
			"attacks": [
				{
					"cost": [
						"Grass"
					],
					"damage": 20
				},
				{
					"cost": [
						"Grass",
						"Grass",
						"Colorless"
					],
					"damage": 130
				}
			],
			"set": {
				"id": "M6",
				"cardCount": {
					"official": 76
				}
			}
		},
		"research": {
			"ranked": [],
			"top": null,
			"verdict": "none"
		},
		"setDate": "2026-07-31"
	}
};

export const ENGLISH = [
	{
		"id": "me04-001",
		"localId": "001",
		"name": "Weedle",
		"category": "Pokemon",
		"dexId": [
			13
		],
		"illustrator": "sowsow",
		"hp": 50,
		"rarity": "Common",
		"image": "https://assets.tcgdex.net/en/me/me04/001",
		"attacks": [
			{
				"cost": [
					"Grass"
				],
				"damage": "30"
			}
		],
		"setId": "me04",
		"setDate": "2026-05-22",
		"official": 86,
		"setName": "Chaos Rising"
	},
	{
		"id": "swsh11-093",
		"localId": "093",
		"name": "Aerodactyl VSTAR",
		"category": "Pokemon",
		"dexId": [
			142
		],
		"illustrator": "5ban Graphics",
		"hp": 260,
		"rarity": "Holo Rare VSTAR",
		"image": "https://assets.tcgdex.net/en/swsh/swsh11/093",
		"attacks": [
			{
				"cost": [
					"Fighting",
					"Colorless",
					"Colorless"
				],
				"damage": "240"
			},
			{
				"cost": [
					"Colorless"
				],
				"damage": null
			}
		],
		"setId": "swsh11",
		"setDate": "2022-09-09",
		"official": 196,
		"setName": "Lost Origin"
	},
	{
		"id": "swsh11-199",
		"localId": "199",
		"name": "Aerodactyl VSTAR",
		"category": "Pokemon",
		"dexId": [
			142
		],
		"illustrator": "5ban Graphics",
		"hp": 260,
		"rarity": "Secret Rare",
		"image": "https://assets.tcgdex.net/en/swsh/swsh11/199",
		"attacks": [
			{
				"cost": [
					"Fighting",
					"Colorless",
					"Colorless"
				],
				"damage": "240"
			},
			{
				"cost": [
					"Colorless"
				],
				"damage": null
			}
		],
		"setId": "swsh11",
		"setDate": "2022-09-09",
		"official": 196,
		"setName": "Lost Origin"
	},
	{
		"id": "me04-115",
		"localId": "115",
		"name": "Tool Scrapper",
		"category": "Trainer",
		"effect": "Choose up to 2 Pokémon Tools attached to Pokémon (yours or your opponent's) and discard them.",
		"illustrator": "Studio Bora Inc.",
		"rarity": "Ultra Rare",
		"trainerType": "Item",
		"image": "https://assets.tcgdex.net/en/me/me04/115",
		"attacks": [],
		"setId": "me04",
		"setDate": "2026-05-22",
		"official": 86,
		"setName": "Chaos Rising"
	},
	{
		"id": "me04-108",
		"localId": "108",
		"name": "Energy Retrieval",
		"category": "Trainer",
		"effect": "Put up to 2 Basic Energy cards from your discard pile into your hand.",
		"illustrator": "Studio Bora Inc.",
		"rarity": "Ultra Rare",
		"trainerType": "Item",
		"image": "https://assets.tcgdex.net/en/me/me04/108",
		"attacks": [],
		"setId": "me04",
		"setDate": "2026-05-22",
		"official": 86,
		"setName": "Chaos Rising"
	},
	{
		"id": "me02.5-264",
		"localId": "264",
		"name": "Ultra Ball",
		"category": "Trainer",
		"effect": "You can use this card only if you discard 2 other cards from your hand.\nSearch your deck for a Pokémon, reveal it, and put it into your hand. Then, shuffle your deck.",
		"illustrator": "Studio Bora Inc.",
		"rarity": "Ultra Rare",
		"trainerType": "Item",
		"image": "https://assets.tcgdex.net/en/me/me02.5/264",
		"attacks": [],
		"setId": "me02.5",
		"setDate": "2026-01-30",
		"official": 217,
		"setName": "Ascended Heroes"
	},
	{
		"id": "me02.5-212",
		"localId": "212",
		"name": "Tool Scrapper",
		"category": "Trainer",
		"effect": "Choose up to 2 Pokémon Tools attached to Pokémon (yours or your opponent's) and discard them.",
		"illustrator": "Studio Bora Inc.",
		"rarity": "Common",
		"trainerType": "Item",
		"image": "https://assets.tcgdex.net/en/me/me02.5/212",
		"attacks": [],
		"setId": "me02.5",
		"setDate": "2026-01-30",
		"official": 217,
		"setName": "Ascended Heroes"
	},
	{
		"id": "me04-113",
		"localId": "113",
		"name": "Special Red Card",
		"category": "Trainer",
		"effect": "You can use this card only if your opponent has 3 or fewer Prize cards remaining.\n\nYour opponent shuffles their hand and puts it on the bottom of their deck. If they put any cards on the bottom of their deck in this way, they draw 3 cards.",
		"illustrator": "Studio Bora Inc.",
		"rarity": "Ultra Rare",
		"trainerType": "Item",
		"image": "https://assets.tcgdex.net/en/me/me04/113",
		"attacks": [],
		"setId": "me04",
		"setDate": "2026-05-22",
		"official": 86,
		"setName": "Chaos Rising"
	},
	{
		"id": "me03-113",
		"localId": "113",
		"name": "Poké Pad",
		"category": "Trainer",
		"effect": "Search your deck for a Pokémon that doesn't have a Rule Box, reveal it, and put it into your hand. Then, shuffle your deck. (Pokémon ex, Pokémon V, etc. have Rule Boxes.)",
		"illustrator": "Studio Bora Inc.",
		"rarity": "Ultra Rare",
		"trainerType": "Item",
		"image": "https://assets.tcgdex.net/en/me/me03/113",
		"attacks": [],
		"setId": "me03",
		"setDate": "2026-03-27",
		"official": 88,
		"setName": "Perfect Order"
	},
	{
		"id": "me05-107",
		"localId": "107",
		"name": "Energy Switch",
		"category": "Trainer",
		"effect": "Move a Basic Energy from 1 of your Pokémon to another of your Pokémon.",
		"illustrator": "Studio Bora Inc.",
		"rarity": "Ultra Rare",
		"trainerType": "Item",
		"image": "https://assets.tcgdex.net/en/me/me05/107",
		"attacks": [],
		"setId": "me05",
		"setDate": "2026-07-17",
		"official": 84,
		"setName": "Pitch Black"
	},
	{
		"id": "me03-117",
		"localId": "117",
		"name": "Wondrous Patch",
		"category": "Trainer",
		"effect": "Attach a Basic {P} Energy card from your discard pile to 1 of your Benched {P} Pokémon.",
		"illustrator": "Studio Bora Inc.",
		"rarity": "Ultra Rare",
		"trainerType": "Item",
		"image": "https://assets.tcgdex.net/en/me/me03/117",
		"attacks": [],
		"setId": "me03",
		"setDate": "2026-03-27",
		"official": 88,
		"setName": "Perfect Order"
	},
	{
		"id": "swsh2-6",
		"localId": "6",
		"name": "Heracross",
		"category": "Pokemon",
		"dexId": [
			214
		],
		"illustrator": "otumami",
		"hp": 130,
		"rarity": "Uncommon",
		"image": "https://assets.tcgdex.net/en/swsh/swsh2/6",
		"attacks": [
			{
				"cost": [
					"Colorless",
					"Colorless"
				],
				"damage": "30"
			},
			{
				"cost": [
					"Grass",
					"Grass",
					"Colorless"
				],
				"damage": "110"
			}
		],
		"setId": "swsh2",
		"setDate": "2020-05-01",
		"official": 192,
		"setName": "Rebel Clash"
	},
	{
		"id": "swsh6-6",
		"localId": "6",
		"name": "Heracross",
		"category": "Pokemon",
		"dexId": [
			214
		],
		"illustrator": "Hasuno",
		"hp": 120,
		"rarity": "Common",
		"image": "https://assets.tcgdex.net/en/swsh/swsh6/6",
		"attacks": [
			{
				"cost": [
					"Colorless"
				],
				"damage": "20"
			},
			{
				"cost": [
					"Grass",
					"Colorless"
				],
				"damage": "40+"
			}
		],
		"setId": "swsh6",
		"setDate": "2021-06-18",
		"official": 198,
		"setName": "Chilling Reign"
	},
	{
		"id": "swsh10-008",
		"localId": "008",
		"name": "Heracross",
		"category": "Pokemon",
		"dexId": [
			214
		],
		"illustrator": "aoki",
		"hp": 110,
		"rarity": "Common",
		"image": "https://assets.tcgdex.net/en/swsh/swsh10/008",
		"attacks": [
			{
				"cost": [
					"Grass",
					"Colorless"
				],
				"damage": "40"
			},
			{
				"cost": [
					"Grass",
					"Grass",
					"Colorless"
				],
				"damage": "120"
			}
		],
		"setId": "swsh10",
		"setDate": "2022-05-27",
		"official": 189,
		"setName": "Astral Radiance"
	},
	{
		"id": "sv01-002",
		"localId": "002",
		"name": "Heracross",
		"category": "Pokemon",
		"dexId": [
			214
		],
		"illustrator": "Taira Akitsu",
		"hp": 120,
		"rarity": "Uncommon",
		"image": "https://assets.tcgdex.net/en/sv/sv01/002",
		"attacks": [
			{
				"cost": [
					"Grass",
					"Colorless"
				],
				"damage": "10+"
			},
			{
				"cost": [
					"Grass",
					"Grass",
					"Colorless"
				],
				"damage": "90"
			}
		],
		"setId": "sv01",
		"setDate": "2023-03-31",
		"official": 198,
		"setName": "Scarlet & Violet"
	},
	{
		"id": "sv02-006",
		"localId": "006",
		"name": "Heracross",
		"category": "Pokemon",
		"dexId": [
			214
		],
		"illustrator": "GOSSAN",
		"hp": 130,
		"rarity": "Uncommon",
		"image": "https://assets.tcgdex.net/en/sv/sv02/006",
		"attacks": [
			{
				"cost": [
					"Grass",
					"Grass"
				],
				"damage": "50"
			},
			{
				"cost": [
					"Grass",
					"Grass",
					"Grass"
				],
				"damage": "110"
			}
		],
		"setId": "sv02",
		"setDate": "2023-06-09",
		"official": 193,
		"setName": "Paldea Evolved"
	},
	{
		"id": "sv02-194",
		"localId": "194",
		"name": "Heracross",
		"category": "Pokemon",
		"dexId": [
			214
		],
		"illustrator": "Kurata So",
		"hp": 130,
		"rarity": "Illustration rare",
		"image": "https://assets.tcgdex.net/en/sv/sv02/194",
		"attacks": [
			{
				"cost": [
					"Grass",
					"Grass"
				],
				"damage": "50"
			},
			{
				"cost": [
					"Grass",
					"Grass",
					"Grass"
				],
				"damage": "110"
			}
		],
		"setId": "sv02",
		"setDate": "2023-06-09",
		"official": 193,
		"setName": "Paldea Evolved"
	},
	{
		"id": "sv06-008",
		"localId": "008",
		"name": "Heracross",
		"category": "Pokemon",
		"dexId": [
			214
		],
		"illustrator": "Toshinao Aoki",
		"hp": 120,
		"rarity": "Uncommon",
		"image": "https://assets.tcgdex.net/en/sv/sv06/008",
		"attacks": [
			{
				"cost": [
					"Grass",
					"Colorless",
					"Colorless"
				],
				"damage": "60"
			},
			{
				"cost": [
					"Grass",
					"Colorless",
					"Colorless",
					"Colorless"
				],
				"damage": "130"
			}
		],
		"setId": "sv06",
		"setDate": "2024-05-24",
		"official": 167,
		"setName": "Twilight Masquerade"
	},
	{
		"id": "me02-004",
		"localId": "004",
		"name": "Mega Heracross ex",
		"category": "Pokemon",
		"dexId": [
			214
		],
		"illustrator": "5ban Graphics",
		"hp": 280,
		"rarity": "Double rare",
		"image": "https://assets.tcgdex.net/en/me/me02/004",
		"attacks": [
			{
				"cost": [
					"Grass",
					"Grass"
				],
				"damage": "100+"
			},
			{
				"cost": [
					"Grass",
					"Grass",
					"Grass"
				],
				"damage": "170"
			}
		],
		"setId": "me02",
		"setDate": "2025-11-14",
		"official": 94,
		"setName": "Phantasmal Flames"
	},
	{
		"id": "me02-108",
		"localId": "108",
		"name": "Mega Heracross ex",
		"category": "Pokemon",
		"dexId": [
			214
		],
		"illustrator": "5ban Graphics",
		"hp": 280,
		"rarity": "Ultra Rare",
		"image": "https://assets.tcgdex.net/en/me/me02/108",
		"attacks": [
			{
				"cost": [
					"Grass",
					"Grass"
				],
				"damage": "100+"
			},
			{
				"cost": [
					"Grass",
					"Grass",
					"Grass"
				],
				"damage": "170"
			}
		],
		"setId": "me02",
		"setDate": "2025-11-14",
		"official": 94,
		"setName": "Phantasmal Flames"
	}
];
