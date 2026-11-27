// What's new, with the version (plans/roadmap.md): the app's version, a
// short list of what each release changed in friendly words, and the sheet
// that shows it. The text ships with the app, so it works offline; write a
// new entry at the top at each release, in plain words for the family, not
// CHANGELOG.md's.
//
// The running version is the active service worker's: sw.js names its shell
// cache `card-tracker-shell-<VERSION>`. The worker is asked first (a sw.js
// that answers {type: 'version'}), and else the shell caches are read, oldest
// first: the active worker's cache comes before the one a newer worker
// installed. With no worker (tests, a browser without them, the first load
// before the worker is ready) there is no version, and the Profile line says
// "Card Tracker" alone.
//
// Styles are in css/whats-new.css.

import {h} from './dom.js';
import {openDialogSheet} from './sheet.js';
import {toast} from './shell.js';

// Newest first. items are short sentences, three or four per release.
export const RELEASES = [
	{
		date: '2026-11-27',
		items: [
			'When you check an order\'s last card, it moves to Ready on its own five seconds later. Uncheck it in that time and it stays in Separating. A payment moves an order from Unpaid to Separating the same way.',
			'A check that has not reached the server yet says "not saved yet", because your other devices do not see it. It goes out the next time the app reaches the server.',
			'A check the server refuses, such as one on an order that is no longer open, is unchecked, and a message says why.',
		],
		version: 'v127',
	},
	{
		date: '2026-11-27',
		items: [
			'A card in two binders is held in both right away, with no need to refresh a binder: each pocket takes its own copy, and only copies no pocket uses are spare.',
			'A copy you add later fills a pocket that fits it, even one marked Keep the placeholder; the binder page shows it after its next refresh.',
		],
		version: 'v126',
	},
	{
		date: '2026-11-27',
		items: [
			'Every 30th Celebration card is named Holo with its anniversary stamp, on the card page, Check spares, the Shop, and HOTARU.',
			'Only the name changes: your copies, their saved finish, and what is for sale stay as they were.',
		],
		version: 'v125',
	},
	{
		date: '2026-11-26',
		items: [
			'Each binder pocket now holds its own copy: a second copy goes to the next binder that has that card, so it is no longer for sale. A pocket you keep empty on purpose needs Keep the placeholder, or its card stops being for sale.',
			'A card with only one printing counts a copy with no finish as that printing.',
			'Tap a pocket on Check spares to open it, with Keep the placeholder two taps away.',
			'Fix a copy\'s finish from Check spares.',
		],
		version: 'v124',
	},
	{
		date: '2026-11-26',
		items: [
			'Orders has four filters: Unpaid, Separating, Ready, and Delivered. All is gone, since the four cover every order.',
			'A paid order is Separating until you tick every card, then Ready to hand over. No extra button.',
			'Ticks are saved online, so the phone and the computer show the same ones. A tick made offline goes up when you are back.',
			'Delivered shows the orders handed over in the last 30 days.',
			'Delete a consigned card or a consignor added by mistake.',
		],
		version: 'v123',
	},
	{
		date: '2026-11-26',
		items: [
			'A copy is a spare only when you have another copy in the same finish. Three normals and one reverse holo are two spare normals, and the reverse holo stays yours.',
			'This counts everywhere a spare does: Trade, Check spares, the ×N | M on a tile, and the Shop.',
			'The next time you open the Shop, HOTARU drops any card that was your only copy in its finish.',
			'Check spares has a Checked button: the card leaves the list and the next one comes up. Show: Checked lists them again.',
			'A checked card comes back by itself when its copies change.',
		],
		version: 'v122',
	},
	{
		date: '2026-11-26',
		items: [
			'Consign has its own tab in the Shop, beside Prices, Kits, and Orders, and each consigned card shows what you keep beside its price.',
			'Consign a card takes you to your cards: open one and its Consign sheet opens by itself, and saving brings you back to the Consign tab.',
			'A consignor with no cards for sale and nothing owed can be removed, and restored later. Their history stays.',
			'Each card in an order shows its finish, a consigned card\'s line stands out in yellow, and holding a card, or hovering on a computer, shows its picture.',
			'The favorite star on a card page stays right beside Your copies, with one copy or several.',
			'No stray "null" under a trade\'s note.',
		],
		version: 'v121',
	},
	{
		date: '2026-11-26',
		items: [
			'Filters take more than one choice: two sets, two languages, or Fire and Water at once. A card shows when it fits any of them.',
			'Each choice gets its own chip above the list, so you can drop one set and keep the rest.',
			'Check spares has a search, Filters, and a sort: Most free, Where, Set (oldest or newest), Name, or Pokédex.',
			'Check spares narrows to one place, a binder, a tray, or loose copies, and shows All cards, With free copies, None free, or Favorites.',
		],
		version: 'v120',
	},
	{
		date: '2026-11-26',
		items: [
			'Each card of an order in the Shop\'s Orders tab has a box: tick it off as you put the order together, so the right cards go out.',
			'A kit\'s cards each have their own box, and a line under the cards counts what you have checked.',
			'The ticks stay on this phone or computer until the order is delivered or cancelled.',
		],
		version: 'v119',
	},
	{
		date: '2026-11-26',
		items: [
			'The Shop has three tabs: Prices to price your cards, Kits, and Orders, where Consignment now sits.',
			'Orders filters All, Unpaid, and Ready: Ready is paid and waiting to be put together and handed over.',
			'A new order or a Pix receipt shows a message in the app. Turn on alerts in Orders to also hear a chime and get a Chrome notification.',
			'Alerts come while the Card Tracker is open, even in a tab behind others. With the app closed, the order waits for you in Orders.',
		],
		version: 'v118',
	},
	{
		date: '2026-11-26',
		items: [
			'Consign: sell someone else\'s card on HOTARU for a commission. Tap Consign on the card\'s page; it never enters your collection.',
			'The commission comes out of the price: 15%, at least R$ 5,00 a card. Change it for the shop, for one person, or for one card.',
			'The Shop\'s Consignment section lists each person\'s cards and what you owe them, and copies a statement to send on WhatsApp.',
			'Once an order is paid and delivered, Pay shows a Pix QR code and copia e cola for what you owe, from the person\'s Pix key. Mark paid records it.',
		],
		version: 'v117',
	},
	{
		date: '2026-11-25',
		items: [
			'A card you own more than once shows how many copies are free beside the count: ×3 | 1 is three copies, one free to trade or sell.',
			'A copy in a binder pocket, a favorite card, the one copy kept, and a spare you took off sale are not free.',
			'Check spares, from Spares or Check under Your copies, shows where every copy is and why it counts as free or not.',
			'I don\'t have this one logs a copy you cannot find as given away in Trades, so your spares and the Shop follow. Undo takes it back.',
		],
		version: 'v116',
	},
	{
		date: '2026-11-25',
		items: [
			'A binder pocket counts different cards, not copies: ×2 means two different cards fit, however many spares you have.',
			'Edit pocket and the pocket viewer show each card once, with ×N for its copies.',
			'A card you own in more than one finish shows a badge for each, such as REG and REV.',
			'The Shop\'s HOTARU admin button opens lojahotaru.com.br, HOTARU\'s new address.',
		],
		version: 'v115',
	},
	{
		date: '2026-11-25',
		items: [
			'Edit copy names the kit a copy is in, under For sale on HOTARU, and says the kit leaves HOTARU too when you keep the copy.',
			'Starring a card that is in a kit says the kit left HOTARU with it.',
			'Tick cards anywhere in the Shop and a bar at the bottom offers Fill and Kit for them, so there is no scrolling back up.',
			'The Shop\'s Kit button sits beside Fill, at the same size, instead of squeezed among the links.',
		],
		version: 'v114',
	},
	{
		date: '2026-11-25',
		items: [
			'Kits on HOTARU: tick two or more priced cards in the Shop, tap the Kit button, and sell them together at a price you type or a percent off their sum.',
			'Each card in a kit is still sold on its own too. When one sells, the next Publish puts another copy of the same card in the kit, if you have one.',
			'The Shop lists your kits with their price and whether they are on HOTARU, and an order shows a kit\'s cards under its name.',
			'Filter the Shop by finish, for example to price every reverse holo at once.',
		],
		version: 'v113',
	},
	{
		date: '2026-11-25',
		items: [
			'Every copy you list on HOTARU now goes up with its picture, including a second copy of a card that is already there.',
			'Binder pockets show a small tag when a copy in them is for sale on HOTARU.',
			'Edit copy shows the Shop price of the copy\'s finish under For sale on HOTARU, and you can change it there.',
		],
		version: 'v112',
	},
	{
		date: '2026-11-24',
		items: [
			'For sale on HOTARU: tick it on any copy in Edit copy, even your last one, one in a binder, or a favorite. Untick it to keep a copy, and it leaves HOTARU at once.',
			'The Shop has Sell a card I own and Add and sell, its buttons show even when it opens from its address, and My Cards tags the cards on HOTARU with For sale.',
			'A copy fills one binder pocket at a time: list binders that share it show a placeholder where an older or more specific binder uses it, and a hand pick always shows.',
			'Add to binder lists every binder, and says before the tap whether the copy fills its pocket or goes after the list.',
			'Insert a pocket anywhere in a binder, such as a third pocket for the female and male Meowstic, and remove an empty one.',
			'Holo cards show a HOLO corner, the binder copy pickers show each copy\'s finish, and the English stand-in image is marked by a small flag.',
		],
		version: 'v111',
	},
	{
		date: '2026-11-24',
		items: [
			'A card with no catalog picture is listed on HOTARU with your own photo, and a copy added by hand counts with the same catalog card in the Shop.',
			'A price typed the moment the Shop opens is no longer lost.',
			'In a binder made from a list, Not this copy here skips a copy, Keep the placeholder keeps the pocket for a copy you get later, and Extra pages adds blank pages after the list.',
			'Lists count every language unless you pick some, and Japanese and Chinese prints with no Pokédex number, and hand-made cards, now count on lists and fill list binders.',
		],
		version: 'v110',
	},
	{
		date: '2026-11-24',
		items: [
			'The Shop bag at the top shows how many HOTARU orders are open, so a new one is seen at once.',
			'Shop: Add sealed products on HOTARU opens its page for sealed products, already signed in.',
			'The Shop\'s set filter shows each set\'s code before its name, like (CRI) Caos Ascendente, and the older sets\' symbols.',
			'Each finish of a card has its own price in the Shop, tagged on its row, and the counts of priced cards and of cards on HOTARU count finishes.',
			'A Reverse holo copy is no longer offered on HOTARU as Normal.',
		],
		version: 'v109',
	},
	{
		date: '2026-11-24',
		items: [
			'A favorite is never a spare: one star keeps every copy of the card, in every language and finish, out of Spares, Trade ideas, and the Shop.',
			'Starring a card you sell takes it off HOTARU at once, and a starred card offers to star its Japanese print too.',
			'A favorite going out in a trade or sale is logged only after you confirm it.',
		],
		version: 'v108',
	},
	{
		date: '2026-11-24',
		items: [
			'A copy in a binder is never a spare: three copies with two in binders are one spare, the loose one.',
			'In a binder made from a list, only the copy on top of a pocket is in use; the copies under it stay spares.',
			'The Shop offers only loose spares to HOTARU, so a card in a binder is no longer listed for sale.',
		],
		version: 'v107',
	},
	{
		date: '2026-11-24',
		items: [
			'A collection that fills itself lists your sets by name when you choose them, not by a code such as international|xy3.',
			'Its description on the collection page names the sets the same way.',
		],
		version: 'v106',
	},
	{
		date: '2026-11-24',
		items: [
			'Shop has moved to the top of the screen: the bag beside your picture opens it from anywhere.',
			'Only the family\'s owner sees it. The rest of the family no longer gets a Shop button in Spares.',
			'Searching the Shop by a Pokémon\'s English name finds its Japanese and Korean prints, even right after opening the app on it.',
		],
		version: 'v105',
	},
	{
		date: '2026-11-24',
		items: [
			'HOTARU sells sealed products too: their orders show in the Shop beside the cards, marked Sealed.',
			'Payment received works the same for them. Only the cards of an order go to your Trades; the sealed products are named in its note.',
			'Shop: tick the cards you want and Fill selected gives them one price. Ticks stay through a search, so you can gather cards from several.',
		],
		version: 'v104',
	},
	{
		date: '2026-11-24',
		items: [
			'HOTARU orders on the Shop screen: who ordered, their phone, the cards, the total, and how long they have left to pay.',
			'Payment received logs the sale in your Trades and takes the cards out of your spares. Delivered and Cancel order close the rest.',
			'When a buyer sends their Pix receipt, open it from their order to check it against your account.',
		],
		version: 'v103',
	},
	{
		date: '2026-11-24',
		items: [
			'Shop: type the prices of as many cards as you like, then Save them all at once from the bar above the tabs.',
			'Enter moves on to the next card\'s price, and Discard drops what you typed. Prices you typed wait for you if you leave the Shop and come back.',
			'Fill all shown types one price into every card shown, for you to save with the rest.',
			'Toasts no longer pile up: a new save replaces the last one, and at most three show anywhere.',
		],
		version: 'v102',
	},
	{
		date: '2026-11-24',
		items: [
			'Shop, from Spares: give each spare card the price you sell it for on HOTARU. The TCGplayer and Cardmarket suggestions beside it are for you only.',
			'Price all shown gives one price to every card your search and filters show, such as every common in a set, with Undo.',
			'A priced card goes on the HOTARU catalog with its picture, and clearing the price takes it off. Each card says when it is on HOTARU or reserved.',
		],
		version: 'v101',
	},
	{
		date: '2026-11-23',
		items: [
			'Trade ideas with each family member: your spares on their wishlist, and their spares on yours, on one screen.',
			'Open it from Trade ideas on their cards or their wishlist, or from Profile > Family, which also counts your spares on each wishlist.',
			'Log a trade with them opens the trade form with both sides and their name filled in, ready to trim and save.',
		],
		version: 'v100',
	},
	{
		date: '2026-11-23',
		items: [
			'A binder\'s cover can be any color: the last circle under Cover color, a rainbow marked Any color, opens your phone\'s color picker, so the binder matches the one on your shelf.',
			'Once you pick a color there, the circle shows it inside a rainbow ring.',
			'A binder you edit shows its new cover color at once. Before, it kept the old color until you opened the binder again.',
		],
		version: 'v99',
	},
	{
		date: '2026-11-23',
		items: [
			'On a card page, the full-screen card closes with a tap anywhere outside the card, so you no longer have to reach for the X.',
			'A copy two phones each logged out in a trade or sale while offline, with both of them undone later, comes back to your collection, its pocket, and its tray. Before, it stayed out.',
		],
		version: 'v98',
	},
	{
		date: '2026-11-21',
		items: [
			'Undo after Start over keeps the changes you made to a copy since, such as its condition, storage, price, notes, grade, language, or finish, when it merges that copy into the one it restored.',
			'Before, the restored copy\'s older value could win over your newer edit.',
		],
		version: 'v97',
	},
	{
		date: '2026-11-21',
		items: [
			'Undo after Start over now says when a copy you changed was merged into the copy it restored, so its numbers add up to your cards.',
			'A copy you changed that matched none of the restored copies is still said to be kept, as before.',
		],
		version: 'v96',
	},
	{
		date: '2026-11-20',
		items: [
			'A new version now takes over only when you come back after at least 5 minutes away, never while you move between screens, and a card in hand or a family member\'s view carries over.',
			'Trades and sales warns when one card was logged leaving on two phones, on both entries, until you undo the one that did not happen.',
			'A purchase with one total says "1 of 3 cards bought for", and editing one of several copies changes the one in the binder pocket the row names.',
			'The Log a trade or purchase form keeps its cards through a reload; a binder page you read again is offered the page its cards are on; 025/165 finds that card; Stats counts cards as My Cards does.',
		],
		version: 'v95',
	},
	{
		date: '2026-11-20',
		items: [
			'The switch to a new version also waits while a form has a choice you made but did not save yet, such as a new colour or grid in Edit binder.',
			'It waits while a message offers Undo, too, so you can still take an action back.',
		],
		version: 'v94',
	},
	{
		date: '2026-11-20',
		items: [
			'Phone check can show one set as this phone holds it (copies, card records, the Sets count, and the saved set list) and copy it to send, so a set that counts wrong on one phone can be looked into.',
			'A binder page you marked Already mine keeps a dot on the Scan tab until you place it, and clearing the tray can be undone to bring it back.',
		],
		version: 'v93',
	},
	{
		date: '2026-11-20',
		items: [
			'Card Tracker moves to a new version by itself when you come back to it or change screens, so your phones and computer stay on the same version.',
			'It waits while you scan, type, or have a sheet open, and Reload still works as before.',
		],
		version: 'v92',
	},
	{
		date: '2026-11-20',
		items: [
			'A card whose small picture is missing at the catalog shows its large one, in binders and My Cards, so a pocket is no longer blank while the card page shows the picture.',
			'A set with no logo in Portuguese (Fagulhas Impetuosas, Fogo Branco, Raio Preto) shows its English logo; a set with no logo at all still shows its name.',
		],
		version: 'v91',
	},
	{
		date: '2026-11-20',
		items: [
			'A new set\'s Pokémon count in your Pokédex lists once TCGdex gives their numbers: a 30th Celebration Mew saved before then was missing from Kanto.',
			'Their numbers also reach My Cards\' Pokédex filter and sort and the binder layouts that go by Pokédex order.',
		],
		version: 'v90',
	},
	{
		date: '2026-11-20',
		items: [
			'Sets: a set\'s ring and its page count only your cards in the language you are viewing, so your English and Portuguese sets fill up separately.',
			'Switch Owned: to Any language to count a card whatever language your copy is in; each phone remembers the choice.',
		],
		version: 'v89',
	},
	{
		date: '2026-11-20',
		items: [
			'A set\'s ring counts every card you own from it on every phone, including cards another phone scanned that this one has not read yet (a new set could show 57 of 161 on one phone and 147 on another).',
			'A card whose picture was saved missing in one language shows its picture from another, in binders and My Cards.',
		],
		version: 'v88',
	},
	{
		date: '2026-11-20',
		items: [
			'Prices on your cards drop the "US" mark, as "~" already says it is an estimate; a price you typed from Liga Pokémon carries a small "Liga" tag.',
			'Lists: Checklists is now Progress, with your checklists and goals under their own headings, and a new list waits behind "+ New list".',
		],
		version: 'v87',
	},
	{
		date: '2026-11-20',
		items: [
			'Card Tracker opens about twice as fast on a slow phone, and Show more no longer slows down with each tap.',
			'My Cards: the buttons take less room, the flag sits in the card\'s bottom corner instead of over its name, and Filters starts with set and language.',
			'Binders fit all nine pockets above the tab bar, Log a trade or sale starts with the cards, and the wishlist shows roughly what each card costs.',
			'Scanning reads the number first and takes cards from the sets you just scanned sooner, and buttons, fields, and focus are easier to see and tap.',
		],
		version: 'v86',
	},
	{
		date: '2026-11-20',
		items: [
			'Binder page scan: the page opens as a grid while it is read, one tap sets the language for the whole page, and Already mine places a page of cards you own into a binder.',
			'Scan has a Buy mode: the cards are logged as a purchase, with where they came from and a price for each. Close, Photo, and Page now sit beside the shutter.',
			'A card to check names the guess ("Wartortle?"), and a card that shares its picture with a print the catalog has no image of asks for its number.',
			'My Cards shows your cards higher up, a card page shows its price beside the picture, a binder on an upright phone opens on one page, and Stats shows your lists\' progress.',
		],
		version: 'v85',
	},
	{
		date: '2026-11-19',
		items: [
			'Binder page scan: a Portuguese or English card no longer comes out as the Japanese print of the same picture. It still asks you to check it.',
			'Every card from a binder page now gets a language; one could be left with none.',
		],
		version: 'v84',
	},
	{
		date: '2026-11-19',
		items: [
			'Stats: in My Cards, Stats (beside Value) shows your copies by language, set, rarity, type, finish, and condition, the ten most valuable, and what you added each month.',
			'Share a card or a binder page as a picture: Share on a card page, or Share page in a binder, sends it through the phone\'s share sheet, to WhatsApp for example.',
			'Print placeholders: in your binder, print real-size paper cards for the pockets you still need, to slip into the real binder until the card arrives.',
			'Search forgives a typo when nothing matches as typed ("charzard" finds Charizard), and a binder page scan is sure of more cards and shows its progress while it reads.',
		],
		version: 'v83',
	},
	{
		date: '2026-11-19',
		items: [
			'Scan a whole binder page from one photo: in Scan, open Settings, then Binder page. Take or choose a photo of one page, or of two pages open side by side, filling the photo.',
			'Each card on the page joins the tray; the ones the scanner is not sure of ask you to check them, and empty pockets are skipped.',
			'Also: bulk Finish, Undo after a bulk Language change, and Needs a photo are fixed, a Trade can bring in a finish the catalog does not list, and a card dragged to the tray is always the one you lifted.',
		],
		version: 'v82',
	},
	{
		date: '2026-11-18',
		items: [
			'Select many cards in My Cards at once, then change where they are stored, their language, finish, or condition, add them to a binder, or remove them, with Undo.',
			'Any copy can be Normal, Holo, or Reverse holo, even when the catalog does not list that finish, and one copy of a pile can change on its own.',
			'In a binder made from a list, tap a pocket with several cards and swipe through them; Show this one here puts that card on top. A hand-made binder can become a list binder that keeps your picks.',
			'The Value sheet shows your collection\'s value over time, and a card page shows its recent Cardmarket prices.',
			'Whole picture frames a photo edge to edge, for a picture that already is the card; a card can be dragged from a pocket onto the tray; Liga links for MEP promos find the card; the scanner knows the newest Mega Evolution set; and Needs a photo leaves out cards already shown with the English print\'s picture.',
		],
		version: 'v81',
	},
	{
		date: '2026-11-18',
		items: [
			'My Cards has a Pictures filter: No photo, No catalog picture, or Needs a photo (neither), the cards to photograph so the scanner learns them.',
			'Behind the scenes: the scanner decides once per card whether the stack helps, and checks your photos less often while you scan.',
		],
		version: 'v80',
	},
	{
		date: '2026-11-18',
		items: [
			'The scanner learns cards from your family\'s photos as well as yours: a card your family photographed is recognised on your phone too.',
			'A card found by a photo shows that photo when the scanner asks you to pick, not a card back.',
			'Numbers are read from a smaller copy of the card\'s corner, quicker and just as accurate, and the reader starts behind your first card.',
			'Fixed: in a stack of one set, a card the catalog has no picture of (such as an MEP promo) could be taken as a card of that set. The stack now helps only when the picture clearly found the artwork.',
		],
		version: 'v79',
	},
	{
		date: '2026-11-18',
		items: [
			'Scanning a stack from one set: a reprint whose artwork is shared with an older card (30th Celebration) is taken as the stack\'s print straight away, without reading its number.',
			'The scanner learns cards the catalog has no picture of (MEP promos, 30th Classic Collection, many Korean prints) from your photos: photograph one on its card page and it is recognised by picture from then on.',
		],
		version: 'v78',
	},
	{
		date: '2026-11-18',
		items: [
			'A Portuguese or English card whose picture and number are both unclear no longer waits for its name to be read: in your scans that took about 2 seconds and never found the card.',
			'Japanese and Korean cards still have their names read, since that is often how they are found.',
		],
		version: 'v77',
	},
	{
		date: '2026-11-18',
		items: [
			'The scanner names the cards a picture matches straight from the app, with no download, so most cards show up about half a second sooner, and much sooner on a set the phone has not seen.',
			'A card whose number does not read no longer waits for the other side of the card to be read when none of the cards it could be prints its number there.',
			'Measured on your report of 18 November: 136 scans on versions 72 and 73.',
		],
		version: 'v76',
	},
	{
		date: '2026-11-18',
		items: [
			'Under the hood: tidier code for the card page\'s prices, checklists, collections, and family wishlists. Nothing changes on screen.',
			'The tests no longer reach the real exchange-rate site.',
		],
		version: 'v75',
	},
	{
		date: '2026-11-18',
		items: [
			'On a small phone or with larger text, All, Owned, and Missing put each number under its word when they do not fit, instead of one wrapping alone.',
			'A card page picture with no image keeps its text clear of the Official label.',
			'Wanting a family member\'s Korean copies of a Japanese card asks for Korean.',
			'Export CSV leaves the language empty for a copy with none, and such a file imports back.',
		],
		version: 'v74',
	},
	{
		date: '2026-11-17',
		items: [
			'A copy\'s sheet saves what you changed when you close it, however you close it: Close, Back, or a tap outside. Save still works.',
			'The toast after a save has Undo, which puts the copy back as it was.',
			'Remove copy still saves nothing you changed before tapping it.',
		],
		version: 'v73',
	},
	{
		date: '2026-11-11',
		items: [
			'On a computer, right-click a card\'s picture for Save image as, on its page or full screen.',
			'Save image under the picture saves it as a PNG named after the card, such as "Pikachu - Surging Sparks 057 (EN).png". Your own photos save too.',
			'Signed out, most catalog pictures open in a new tab instead, to save from there.',
		],
		version: 'v72',
	},
	{
		date: '2026-11-09',
		items: [
			'On a Pokémon\'s cards (Every Pikachu card), tap Make this a goal and tick the languages you want.',
			'The goal shows in Lists with how many you own, what is missing, and one tap to add a missing card to your wishlist.',
			'New binder, From a list, then the goal: a binder with a pocket for every card, the ones you own in place and the rest waiting for you to find them.',
		],
		version: 'v71',
	},
	{
		date: '2026-11-09',
		items: [
			'On a card\'s page, tap its Set to open that set\'s page.',
			'Tap Every Jigglypuff card, or whichever Pokémon it is, to see every print of that Pokémon with Owned and Missing, no checklist needed.',
			'A row of flags at the top shows one language at a time, starting with the card\'s own; a language loads only when you tap its flag.',
		],
		version: 'v70',
	},
	{
		date: '2026-11-09',
		items: [
			'My Cards now shows your cards four ways: Large, Grid, Mini, or List.',
			'Pick one from the View menu at the top of My Cards, and your phone remembers it.',
			'Large shows the art big, Mini fits a binder page at a glance, and List gives each card a row with its set, number, language, finish, and copies.',
		],
		version: 'v69',
	},
	{
		date: '2026-11-09',
		items: [
			'The scanner says when you already have a card: a green note over the camera, such as You have 2, and a Have 2 strip on its tray card.',
			'Owned only in another language, the note and strip say which, such as Have PT.',
			'On shorter screens or with large text, the scanner keeps all its buttons on screen; the camera gives up the space.',
			'Profile shows Continue with Google straight away.',
		],
		version: 'v68',
	},
	{
		date: '2026-11-07',
		items: [
			'One name everywhere: Trade or sale. The scanner button says how many cards it logs, such as Log 3 cards.',
			'Held sideways, the scanner keeps all its buttons in a column beside the camera.',
			'Clearer binder screens: a card out of its pocket has Edit pocket, Lay out from a list keeps its buttons on screen, and a binder shows About R$ 4.952 in value.',
		],
		version: 'v67',
	},
	{
		date: '2026-11-06',
		items: [
			'Remove from this binder: take any card out of a binder, even one made from a list, and choose Leave the pocket empty or Shift the rest back.',
			'Move to: send a card to the end of the binder or to any pocket, and the cards in between shift to make room.',
			'In a binder made from a list, your changes stay when it updates. A card you left out is listed under the pages with Put back.',
		],
		version: 'v66',
	},
	{
		date: '2026-11-06',
		items: [
			'Holding the phone sideways in a binder, the page slider sits beside the Scan button, fully visible above the bottom bar.',
			'The page menu sits on the same row, on the other side of the Scan button, so the book keeps its size.',
		],
		version: 'v65',
	},
	{
		date: '2026-11-06',
		items: [
			'Holder mode waits for a sharp look of a blurred card instead of saving it blurred, never takes the same card twice, and never loses a card. A card it is not sure of is marked Check.',
			'Trade or sale picks the copy by itself when your loose copies are alike, and asks for all the cards that need a choice on one sheet.',
			'Trades and sales has Scan a trade, which opens Scan in Trade or sale.',
			'Placeholders take your most valuable copy that fits.',
		],
		version: 'v64',
	},
	{
		date: '2026-11-06',
		items: [
			'Scan a trade or a sale: switch Scan to Trade or sale, scan the cards going out and coming in, and tap Log it.',
			'The trades form opens already filled. Add who and the price, then Save; nothing changes in your cards before that.',
			'A card going out is matched to a spare first. When two copies fit, you pick which one leaves.',
		],
		version: 'v63',
	},
	{
		date: '2026-11-06',
		items: [
			'Tap a card in a binder to take it out of its pocket and look at it large, with zoom. Details, To the tray, Move, and Card page sit under it.',
			'Lay out from a list: a binder you fill by hand can take a checklist, such as Johto, as placeholders in Pokédex order in its empty pockets. Cards you own go in now, and new ones as you add them.',
		],
		version: 'v62',
	},
	{
		date: '2026-11-06',
		items: [
			'Filling a binder, the card pickers sort by Pokédex number, set (oldest first), or name, and remember your pick.',
			'A binder shows what it is worth under its name. Tap it for the breakdown.',
			'Sent scan reports are deleted automatically 30 days after they reach your account.',
		],
		version: 'v61',
	},
	{
		date: '2026-11-05',
		items: [
			'The scanner cuts a card held low or at a strong slant properly, even when its foot or corners are outside the frame.',
			'A card in the frame with a table edge or shelf line above it is no longer taken for something bigger.',
		],
		version: 'v60',
	},
	{
		date: '2026-11-05',
		items: [
			'Profile, Phone check, Send report sends your scan log, with card pictures if you keep them, to a private folder in your account in one tap.',
			'Sent reports lists what you sent and shows each scan. Offline, a report waits and goes up when you are back online.',
		],
		version: 'v59',
	},
	{
		date: '2026-11-05',
		items: [
			'A logged sale, purchase, trade, or gift can be edited: its date, who, price, and note. Changing its cards is still Undo and log again.',
			'A binder made from a list with languages uses only copies in those languages, and a missing card says which language you own it in.',
		],
		version: 'v58',
	},
	{
		date: '2026-11-05',
		items: [
			'Portuguese and French card images stay on the phone more reliably.',
			'Offline, a missing one shows the English image, marked by a small English flag.',
		],
		version: 'v57',
	},
	{
		date: '2026-11-04',
		items: [
			'The scanner reads the names on Japanese and Korean cards.',
			'The first such card downloads the reading data once.',
		],
		version: 'v56',
	},
	{
		date: '2026-11-04',
		items: [
			'Trades on My Cards logs a sale, purchase, trade, or gift: cards out leave your collection and cards in are added, with Undo.',
			'History shows the money in and out each month, a card\'s page says how its copies came and went, and a past sale can use copies you removed in the last 30 days.',
		],
		version: 'v55',
	},
	{
		date: '2026-11-03',
		items: [
			'Your own photos and the main image you chose now show everywhere a card does: binders, placeholders, Sets, a Pokémon\'s cards, goals, and the wishlist.',
			'A card with no official image, like most Korean and Japanese prints, shows your photo there instead of a card back.',
		],
		version: 'v54',
	},
	{
		date: '2026-10-31',
		items: [
			'A photo you took has Adjust on its card page: Auto fixes a dark or flat photo in one tap, and sliders set brightness, contrast, saturation, and warmth.',
			'Hold the photo or tap Original to compare, and Undo edit after saving brings the old photo back.',
		],
		version: 'v53',
	},
	{
		date: '2026-10-31',
		items: [
			'Fill placeholders, on each binder and on the Binders list, puts the cards you own into the pockets waiting for them, in the right language, with Undo.',
			'From now on a card you add by scan, import, or by hand goes into a waiting placeholder by itself (Profile, Binders), and a card on your wishlist moves to Got it.',
		],
		version: 'v52',
	},
	{
		date: '2026-10-31',
		items: [
			'Import has Start over with this file: it removes your copies and adds every card in the monprice file fresh, for a clean slate.',
			'Photos and notes stay with their cards. The preview says what will not come back, and Undo stays available for 7 days.',
			'Undo keeps any new copy you changed since, and after a newer Start over it is no longer offered.',
		],
		version: 'v51',
	},
	{
		date: '2026-10-30',
		items: [
			'When the catalog adds an official image for a card you photographed, the app offers to delete your photos of its front to save space.',
			'Review shows each official image beside your photo, ticked except a photo you chose as the main image, and Undo brings them back.',
		],
		version: 'v50',
	},
	{
		date: '2026-10-30',
		items: [
			'The Sets search finds cards too: type a Pokémon or Trainer name, a number like 025 or 025/165, or a set code and number like MEW 025.',
			'Kinds such as ex, V, VMAX, VSTAR, or SIR narrow it down. Matching sets come first, then the cards, with your owned copies marked.',
		],
		version: 'v49',
	},
	{
		date: '2026-10-30',
		items: [
			'Photos, notes, and the main image now belong to the card, not to one copy: every copy shows them, and so does the card\'s page with no copies left.',
			'Deleting copies never loses a photo or a note. Notes from several copies of a card are all kept, newest first.',
			'A language with no photo of its own shows another language\'s photo of the same card.',
		],
		version: 'v48',
	},
	{
		date: '2026-10-23',
		items: [
			'The card page shows which region and generation a Pokémon is from, like Bulbasaur (Kanto I), so you know which binder it goes in.',
			'Binders have a page slider: drag it to see each spread\'s pages and a small preview, and let go to open it.',
		],
		version: 'v47',
	},
	{
		date: '2026-10-17',
		items: [
			'On a computer or tablet, an open binder fills the screen.',
			'New minus, Fit, and plus buttons resize the binder, and your choice is remembered.',
		],
		version: 'v46',
	},
	{
		date: '2026-10-16',
		items: [
			'Cards with no picture show a family member\'s photo of the same card, marked Photo by and their name, until you add your own.',
			'In your binders, press and hold a card, then drag it to another pocket to move it or swap the two, with Undo.',
			'Add to binder on a card\'s page: pick a binder, then tap an empty pocket, use the next free one, or keep the card in the tray, with Undo.',
			'Filters in Add cards to the tray and the pocket chooser, the same as My Cards, plus a new Artist filter everywhere.',
			'Binder pickers show one tile per card with a count of your copies, and you choose how many go to the tray.',
			'With a mouse, the card pickers open ready to type in the search; phones no longer pop up the keyboard.',
		],
		version: 'v45',
	},
	{
		date: '2026-10-16',
		items: [
			'Share a monprice export straight to Card Tracker on Android: pick Card Tracker in the share sheet and Import opens with the file ready to check and save.',
			'The app\'s own CSV export can be shared to it the same way.',
		],
		version: 'v44',
	},
	{
		date: '2026-10-16',
		items: [
			'Binder pickers find cards by English name, reading, or any language\'s name, just like My Cards.',
			'Clear all appears as soon as any filter or search is on, and clears the search too.',
		],
		version: 'v43',
	},
	{
		date: '2026-10-16',
		items: [
			'Add cards to the tray can take cards from one storage box, checklist, collection, or goal.',
			'A Snap button in the corner editor turns snapping on or off, and corners snap only to real-looking card corners.',
			'Turn a binder cover picture with Rotate; the cover saves the way it shows.',
		],
		version: 'v42',
	},
	{
		date: '2026-10-16',
		items: [
			'Adding a photo finds the card\'s corners in more photos, even a silver card on a silver table.',
			'Corner handles snap onto the card\'s corners as you drag them, with a light buzz; drag further to let go.',
			'When the corners are hard to find, a tip suggests a dark or coloured surface under the card.',
		],
		version: 'v41',
	},
	{
		date: '2026-10-16',
		items: [
			'Holder mode catches a different card even when it lands exactly on the last one; the same card dropped again asks Add a copy or Mistake.',
			'Hand-held: scan the top card, take it off, and the card underneath is taken by itself.',
			'Holder mode switches on by itself when the phone sits still in the stand, and off when you pick it up (Auto, Holder, or Hand-held on the chip).',
			'Cards that are shifted, the wrong size, or partly covered are recognised more often, and a stuck read can no longer hold a card on Reading.',
		],
		version: 'v40',
	},
	{
		date: '2026-10-15',
		items: [
			'Saving a scan session is instant, with "Saving N cards" right away, and a card stuck reading no longer blocks Save.',
			'Cards upside down or on their side are recognised, and taking a picture no longer pauses the scanner.',
			'Scanner settings: a default finish, a shutter sound, and a gold rim with a star for cards worth more than the amount you choose.',
			'Cards whose price is rising get an up arrow, and the card page says how much.',
			'Photos the server refused wait for Retry, and a scanned card says Looking it up instead of showing a code.',
		],
		version: 'v39',
	},
	{
		date: '2026-10-15',
		items: [
			'Lists count the languages you pick: a new list starts with Portuguese, and lists you already have keep counting every language. Ticking every language means Any language again.',
			'The scanner reads the number on full-art cards, and Portuguese, French, and German names, Paradox Pokémon and Trainers included.',
			'Saving sends far less data to your other phones, and My Cards updates faster after an edit.',
			'A card whose twins you turned down is checked again a week later.',
			'Long Japanese and Korean set names show in full in Filters, and more Portuguese and French pictures stay on the phone offline.',
		],
		version: 'v38',
	},
	{
		date: '2026-10-10',
		items: [
			'Fill a binder\'s tray in one go: Add cards to the tray picks many cards that are not in a binder yet, with Undo.',
			'Japanese and Korean card tiles stay tidy on small phones: a long set name ends in an ellipsis.',
			'Japanese set pages show the international print\'s picture for cards with no image of their own.',
		],
		version: 'v37',
	},
	{
		date: '2026-10-10',
		items: [
			'Holder mode takes every card you drop, even on the same spot and at your normal speed, and keeps scanning while you check a card.',
			'Tap any card that needs a look, or the "to check" count, to go through them one after another.',
			'Fewer cards to check: the scanner finds cards whose picture came out a little off.',
			'Light tip for holder mode: the torch, or a lamp beside the box. Share now sends the scan log.',
		],
		version: 'v36',
	},
	{
		date: '2026-10-09',
		items: [
			'The scanner finds the card anywhere in view, bigger or smaller than the frame, and on a pile takes only the card on top.',
			'Holder mode, for a phone in a stand: each card you drop is taken once it settles, and it says when the pile is too high.',
			'Review opens each card that needs a look in turn, with Stop, and those cards are read faster.',
			'The same card taken again moments later asks first, and the shutter waits a moment for a whole card.',
		],
		version: 'v35',
	},
	{
		date: '2026-10-09',
		items: [
			'Binders from a list: pick a checklist, collection, goal, or filter, an order, and a pocket size, and the app lays out the binder.',
			'Each pocket shows your best copy of that card or Pokémon; tap it to pick another. Cards you do not have show faded, with Add to wishlist.',
			'Opening the binder fills in cards you got since, and keeps the copies you picked.',
		],
		version: 'v34',
	},
	{
		date: '2026-10-09',
		items: [
			'Stored in: note where each card lives (a box, a drawer), pick from your saved places, and filter My Cards by place.',
			'Edit order on Lists and Binders: drag them, or use the arrows. Deleting a list or binder now has Undo.',
			'Leave a card out of a collection that fills itself, and put it back later.',
			'Prices come straight from TCGplayer and Cardmarket in reais, even when your copy\'s finish is not listed. Ver na Liga still opens the Brazilian price.',
		],
		version: 'v33',
	},
	{
		date: '2026-10-09',
		items: [
			'Scan card after card without touching the phone: a buzz says it knows the card, and a count shows how many need a look.',
			'Each scanned card has an x to throw away a mistake, and a Copies count for duplicates.',
			'The same card twice in a row asks: Add a copy, or Mistake.',
			'Phone check can record every scan and save them all in one file to send.',
		],
		version: 'v32',
	},
	{
		date: '2026-10-09',
		items: [
			'The scanner skips frames with no card, says Move closer when a card is far, and does not add the same card twice when you reopen it.',
			'A Liga price you type now says which finish and language it is for.',
			'Theme swatches in Profile stay put when you pick a theme.',
			'A note when your phone\'s clock is off, and this list after each update.',
		],
		version: 'v31',
	},
	{
		date: '2026-10-06',
		items: [
			'Add to wishlist from a family member\'s cards, with a line when they have a spare.',
			'A small Value button on sets, checklists, and binders.',
			'A scanned card says which binder pocket waits for it.',
			'Checklist rows no longer tick by hand: a missing row opens the Pokémon\'s cards.',
			'Ver na Liga finds Radiant Collection, Scarlet & Violet promos, and McDonald\'s 2023 cards.',
		],
		version: 'v30',
	},
];

export const SHELL_CACHE_PREFIX = 'card-tracker-shell-';

// The version the What's new sheet last showed on this phone (or recorded
// without showing, on the first install).
const SEEN_KEY = 'cardTracker.whatsNewSeen';

// What SEEN_KEY holds between a first load and the worker's answer.
const FIRST_INSTALL = 'first-install';

// How long a worker gets to answer before the caches are read instead. A
// worker from before v31 never answers.
const ASK_MS = 500;

export const versionOfCache = (name) => (typeof name === 'string' && name.startsWith(SHELL_CACHE_PREFIX) ? name.slice(SHELL_CACHE_PREFIX.length) || null : null);

export const releaseFor = (version) => RELEASES.find((release) => release.version === version) || null;

// "v31" as 31, for telling an update from a rollback; NaN for anything else.
const versionNumber = (version) => (typeof version === 'string' && /^v\d+$/.test(version) ? Number(version.slice(1)) : NaN);

// ------------------------------------------------------- the version

// The version a worker reports, or null when it does not answer in time.
function askWorker(worker) {
	if (!worker || typeof MessageChannel === 'undefined') {
		return Promise.resolve(null);
	}

	return new Promise((resolve) => {
		const channel = new MessageChannel();
		const timer = setTimeout(() => {
			channel.port1.close();
			resolve(null);
		}, ASK_MS);

		channel.port1.onmessage = (event) => {
			clearTimeout(timer);
			channel.port1.close();

			const version = event.data && event.data.version;

			resolve(typeof version === 'string' && version ? version : null);
		};

		try {
			worker.postMessage({type: 'version'}, [channel.port2]);
		}
		catch {
			clearTimeout(timer);
			resolve(null);
		}
	});
}

async function shellCaches() {
	if (typeof caches === 'undefined') {
		return [];
	}

	try {
		return (await caches.keys()).map(versionOfCache).filter(Boolean);
	}
	catch {
		return [];
	}
}

async function registration() {
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
		return null;
	}

	try {
		return (await navigator.serviceWorker.getRegistration()) || null;
	}
	catch {
		return null;
	}
}

// {current, waiting, worker}: the running version and a newer one waiting
// for Reload (null when none), with the waiting worker for applyUpdate.
// Every field is null when there is no worker.
export async function appVersions() {
	const found = await registration();

	if (!found || !found.active) {
		return {current: null, waiting: null, worker: null};
	}

	let [current, waiting] = await Promise.all([askWorker(found.active), askWorker(found.waiting)]);

	if (!current || (found.waiting && !waiting)) {
		// Cache Storage lists names in the order they were made. The active
		// worker's cache comes before any made by a worker still installing
		// or waiting, and activate deletes the older ones.
		const names = await shellCaches();
		const pending = [found.installing, found.waiting].filter(Boolean).length;
		const at = Math.max(0, names.length - 1 - pending);

		current = current || names[at] || null;
		waiting = waiting || (found.waiting ? names[at + 1] || null : null);
	}

	if (waiting && waiting === current) {
		waiting = null;
	}

	return {current, waiting, worker: found.waiting && waiting ? found.waiting : null};
}

// ------------------------------------------------------------- Reload

// How long Reload waits for the new version to finish taking over before it
// gives up and leaves the page as it is.
export const ACTIVATE_MS = 10 * 1000;

let applying = false;

// True while Reload hands over to the new version: the controller change on
// the way is this page's own, so app.js neither offers Reload again nor
// marks the page stale (app.js registerServiceWorker).
export const updateApplying = () => applying;

// Resolves true once `worker` is activated, false when it is redundant or
// still not activated after `ms`.
export function untilActivated(worker, ms = ACTIVATE_MS) {
	return new Promise((resolve) => {
		if (worker.state === 'activated' || worker.state === 'redundant') {
			resolve(worker.state === 'activated');

			return;
		}

		let timer = 0;

		const changed = () => {
			if (worker.state === 'activated' || worker.state === 'redundant') {
				done(worker.state === 'activated');
			}
		};

		function done(activated) {
			clearTimeout(timer);
			worker.removeEventListener('statechange', changed);
			resolve(activated);
		}

		timer = setTimeout(() => done(false), ms);
		worker.addEventListener('statechange', changed);
	});
}

// The update toast again, unless one is showing.
function offerReloadAgain(worker) {
	if ([...document.querySelectorAll('.toast button.small')].some((button) => button.textContent.trim() === 'Reload')) {
		return;
	}

	toast('A new version is installed.', {
		action: () => (worker.state === 'redundant' ? window.location.reload() : applyUpdate(worker)),
		actionLabel: 'Reload',
		timeout: 0,
	});
}

// Reload: the waiting worker takes over, and the page loads its files. The
// same as the update toast's Reload in app.js, and what the switch by itself
// runs (js/auto-update.js), so What's new shows after either.
//
// The page reloads only once the new worker is activated, never on the
// controller change, which comes when it starts activating: the reload's
// request would wait on a worker still activating, where QA suspects a page
// can freeze (2026-11-20, unproven). When the worker is not activated within ACTIVATE_MS
// (the old worker still busy, or an activate step that hangs), nothing
// reloads, Reload is offered again, and the page carries on as it was.
// stillWanted is asked once the worker is activated, and false stops the
// reload the same way (js/auto-update.js: the person started using the page
// during the wait). beforeReload runs just before the reload
// (js/auto-update.js keeps a few things for the next load). Resolves true
// when the page is reloading.
export async function applyUpdate(worker, {beforeReload = null, stillWanted = () => true} = {}) {
	if (!worker || applying) {
		return false;
	}

	applying = true;

	try {
		worker.postMessage('skip-waiting');
	}
	catch {
		// A redundant worker: untilActivated says so.
	}

	if (!(await untilActivated(worker)) || !stillWanted()) {
		applying = false;
		offerReloadAgain(worker);

		return false;
	}

	if (beforeReload) {
		try {
			beforeReload();
		}
		catch {
			// Nothing kept; the reload still runs.
		}
	}

	window.location.reload();

	return true;
}

// -------------------------------------------------------------- sheet

function seenVersion() {
	try {
		return localStorage.getItem(SEEN_KEY);
	}
	catch {
		return null;
	}
}

function rememberSeen(version) {
	try {
		localStorage.setItem(SEEN_KEY, version);
	}
	catch {
		// Private mode or blocked storage: the sheet may show again.
	}
}

function releaseList(release) {
	return h('ul', {class: 'whats-new-items'}, release.items.map((item) => h('li', null, item)));
}

// The What's new sheet: one release ("What's new in v31") after an update,
// or every release, newest first, from Profile.
export function openWhatsNew({version = null} = {}) {
	const id = 'whats-new-sheet';
	const one = version ? releaseFor(version) : null;
	const dialog = h('dialog', {'aria-labelledby': `${id}-title`, class: 'sheet whats-new-sheet', id},
		h('div', {class: 'sheet-head'},
			h('h2', {id: `${id}-title`}, one ? `What's new in ${one.version}` : 'What\'s new'),
			h('button', {class: 'small', id: `${id}-close`, onclick: () => dialog.close(), type: 'button'}, 'Close')
		),
		h('div', {class: 'whats-new-body'},
			one
				? releaseList(one)
				: RELEASES.map((release) => h('section', {class: 'whats-new-release', 'data-version': release.version},
					h('h3', null, release.version, h('span', {class: 'muted whats-new-date'}, ` · ${release.date}`)),
					releaseList(release)
				))
		)
	);

	dialog.addEventListener('click', (event) => {
		if (event.target === dialog) {
			dialog.close();
		}
	});
	dialog.addEventListener('close', () => dialog.remove());
	document.getElementById(id)?.remove();
	document.body.append(dialog);

	return openDialogSheet(dialog);
}

// Called once at start (app.js): after Reload brings a new version, its
// What's new shows once. The first install records the version and shows
// nothing. A page that opened under a worker but has nothing recorded came
// from a version before What's new, so it shows too. Pass `controlled` as
// navigator.serviceWorker.controller was when the page loaded.
export async function showWhatsNewOnce({controlled = Boolean(typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.controller)} = {}) {
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
		return null;
	}

	if (!controlled) {
		// The first install: mark it at once, in case the page is reloaded
		// before the worker answers, then wait for the worker and record.
		if (!seenVersion()) {
			rememberSeen(FIRST_INSTALL);
		}

		try {
			await navigator.serviceWorker.ready;
		}
		catch {
			return null;
		}
	}

	const {current} = await appVersions();

	if (!current) {
		return null;
	}

	const seen = seenVersion();

	if (seen === current) {
		return null;
	}

	rememberSeen(current);

	if ((!seen && !controlled) || seen === FIRST_INSTALL || versionNumber(current) <= versionNumber(seen)) {
		return null;
	}

	return releaseFor(current) ? openWhatsNew({version: current}) : null;
}

// ------------------------------------------------------ Profile line

// "Card Tracker v30 · What's new", and "v31 ready" with Reload while a newer
// version waits. Returns {element, stop}.
export function versionLine() {
	const line = h('p', {class: 'muted whats-new-line', id: 'profile-version'}, 'Card Tracker');
	let alive = true;
	let watched = null;

	const whatsNew = () => h('button', {class: 'link-button whats-new-open', id: 'profile-whats-new', onclick: () => openWhatsNew(), type: 'button'}, 'What\'s new');

	function draw({current = null, waiting = null, worker = null} = {}) {
		line.replaceChildren(...[
			current ? `Card Tracker ${current}` : 'Card Tracker',
			' · ',
			...(waiting && worker
				? [
					h('span', {id: 'profile-version-ready'}, `${waiting} ready`),
					' ',
					h('button', {class: 'small whats-new-reload', id: 'profile-version-reload', onclick: () => applyUpdate(worker), type: 'button'}, 'Reload'),
					' · ',
				]
				: []),
			whatsNew(),
		]);
	}

	async function refresh() {
		const versions = await appVersions();

		if (alive) {
			draw(versions);
		}
	}

	// A newer version that finishes installing while Profile is open.
	function onUpdateFound() {
		const worker = watched && watched.installing;

		worker?.addEventListener('statechange', () => {
			if (worker.state === 'installed') {
				refresh();
			}
		});
	}

	draw();
	refresh();
	registration().then((found) => {
		if (alive && found) {
			watched = found;
			found.addEventListener('updatefound', onUpdateFound);
		}
	});

	return {
		element: line,
		stop() {
			alive = false;

			if (watched) {
				watched.removeEventListener('updatefound', onUpdateFound);
			}
		},
	};
}
