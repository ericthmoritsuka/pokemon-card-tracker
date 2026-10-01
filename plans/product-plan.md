# Pokémon Card Tracker: Product Plan

Draft 2026-10-01. Based on DESIGN.md, monprice store screenshots, and Eric's `Todas` export (1,414 rows, 1,611 cards).

## 1. Product Summary

A private card tracker for Eric and two invited family members, built around a phone camera. Its one job: save every scanned card in the language it is actually printed in, with no setting to forget. It keeps what monprice does well (deep catalog, batch tray, set rings) and drops the portfolio.

## 2. Users and Jobs to Be Done

| User | Known facts | Jobs |
| --- | --- | --- |
| Eric (owner, admin) | Brazil. 1,611 cards, 88% PT by row, then EN, KR, CHS, JA, FR. Back to Base Set. Star collection of IRs and SIRs. Chasing one of every Pokémon. Uses binders, wants Michi pages. No portfolio. | Scan a mixed-language stack and trust every save. Know what is spare. See set progress across languages. Find a card's binder pocket. See what a goal is missing. |
| Invited users | A small number, each with an own account in the family group. Can see the others' collections and wishlists. | *Assumption:* keep their own collection and a wishlist the others read. Nothing else is stated. |

Settled by Eric: invite-only, Eric adds members, no public sign-up. Nothing is private inside the group, purchase prices included.

## 3. Requirements Review

Strongest first.

1. **Quantity on one row breaks other rules (sections 3, 4).** The heading says "a copy sits in at most one slot"; the body says slots "can never outnumber its `quantity`." Both cannot hold. Last-write-wins per row also means two offline phones each adding the same card lose one. Two copies in different conditions need separate rows anyway. **Recommend one row per physical card,** grouped in the UI. The import expands 91 multi-count rows to 1,611 rows.
2. **The build order buries the core job (section 14 vs section 2).** Section 2 names the language bug as the worst problem. Section 14 calls the scanner "least load-bearing" and puts it eighth, after binders. Without a scanner Eric has no reason to switch: monprice already scans. **The scanner and tray belong in the MVP.** Binders, goals, and family browsing do not.
3. **Price history contradicts "no portfolio" (sections 1, 8, 12).** A value-over-time chart is a portfolio, and section 8 says its nightly job is "the one piece that needs more than a database." Drop it and `price_snapshots`. Section 10 says the 1/7/30 day averages already give a trend.
4. **Condition rationale has no support (section 3 vs 10).** TCGplayer's vocabulary is adopted "so the condition field lines up with the price being fetched," but section 10 records no per-condition price in TCGdex, and the import has no condition. Make it optional, blank on import.
5. **CSV vs JSON contradicts itself (sections 3, 9).** Section 3 says CSV cannot hold collection membership; section 9 puts it in a column. With no snapshots or photos, CSV with UUIDs is a full backup, so JSON can wait. Section 9's example also lists `For Trade` as a collection, which section 3 makes a derived view.
6. **Steps 3 and 4 are out of order (section 14).** The import "proves the catalog matching," so the catalog cache comes first. Merge them.
7. **Overbuilt for a few weekends:** a generic multi-group model for one family, a free rule engine for one rule (Star), three set-goal levels, graded fields, own photos, pack openings.
8. **Underspecified: variant on scan (section 6).** The doc says every approach picks the wrong variant confidently, and 135 rows are reverse holo. Nothing says what the confirm screen proposes. Recommend: propose the base print, show a variant chip on every tray card, keep the "all reverse holo" correction.
9. **Underspecified: PT vs EN detection (section 6).** It rests on attack text and an unverified copyright line (section 13). With 1,239 PT and 111 EN rows, this is the likeliest bad save. Test it on Eric's own cards first.
10. **Missing from the doc:** the export's `Average Price` has no currency, and all 56 KR rows lack a price. Refetch prices from TCGdex instead of importing them. 51 rows have rarity `Unknown`, so Star must match on TCGdex rarity.

## 4. Prioritized Scope

| Slice | Item | Why here |
| --- | --- | --- |
| MVP | Eric's account; `user_id` and RLS on every table | Retrofitting RLS is miserable (section 3). |
| MVP | TCGdex catalog cache for en, pt, ja, ko, zh-cn; card images cached on the device | Import and scan both need it. |
| MVP | monprice import with a match report and review queue | No switch without the existing 1,611 cards. |
| MVP | Scanner: single and batch tray, language per card, confidence gate, duplicate badge and prompt, undo | The reason to switch. |
| MVP | Set browser with cross-language rings, `×N` and language chips | Ownership must look right. |
| MVP | Search; filter and sort by set, language, rarity, name, number, date added, price | Minimum to find a card. |
| MVP | Trade view | 197 extras exist on day one. |
| MVP | Star rule; hand-picked tags in one action | Fixes the save-twice pain. |
| MVP | Per-card price labeled with its market | Embedded in TCGdex; display only. |
| MVP | CSV export with UUIDs | The backup from the first save. |
| v1.1 | Invites, read-only family browsing, wishlists | The family's first real use. |
| v1.1 | CSV re-import (merge) | Batch fix for mislabeled cards. |
| v1.1 | Full section 11 filter bar | Needed once others browse. |
| v1.2 | Every Pokémon and set goals, offline missing list, one tap to wishlist | Eric's stated chase. |
| v1.2 | Binders: grid, placement, placeholders, "where is this card" | He uses binders today. |
| Later | Michi art and print inserts | Print specs unverified (section 13); better on a big screen. |
| Later | Master-set goal, ball-pattern and variant detection | Hardest scan problem; the chip covers it until then. |
| Later | Pack openings, graded fields, own photos, JSON backup | Each adds storage or schema. |
| Deferred | Trade matching | Deferred by Eric. |
| Dropped | Pokedex link | Dropped by Eric; the apps stay separate. |
| Dropped | Value chart and snapshots | It is a portfolio. |

## 5. Release Slices

**Weekend zero.** A spike: camera capture and offline IndexedDB writes on each family phone. It decides hosting before feature work.

**MVP.** Eric imports `Todas`, clears the review queue, and sees 1,611 cards with correct rings. He scans a mixed stack offline at a shop, with no language setting anywhere.

**Switch-over.** *Import:* match report clean, total equals 1,611. *Trust:* one real 50-card mixed session, every save checked by hand against the stack. If it passes, he stops saving to monprice and leaves it untouched for a month as a fallback.

**v1.1.** Eric invites the other users. Each sees the others' cards and wishlists. Eric fixes a batch in a spreadsheet and re-imports it.

**v1.2.** Eric sees how many Pokémon he is missing, opens the list offline in a shop, and finds any card's binder page.

## 6. Success Criteria

| Slice | Measured in the app |
| --- | --- |
| MVP import | At least 1,409 of 1,414 rows match automatically (5 are known manual entries, section 5). 1,611 copies. Trade shows 197 extras. |
| MVP scanner | Zero wrong-language saves in a 50-card mixed session, counted as language edits to `language_source = scan` copies within 7 days. At least 90% of tray cards need no identity fix. No low-confidence save without a tap. |
| MVP safety | 20 cards saved in airplane mode all sync. Export, then import into an empty test account, gives identical counts. |
| v1.1 | Both invitees signed in and saved a card or wishlist item within 30 days. Re-importing 20 edited rows updates 20, creates 0. |
| v1.2 | Every placed card shows binder, page, and slot. Placed plus unplaced equals total copies. |

## 7. Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Wrong card or variant | Confidence gate, variant chip, session corrections, undo (section 6). A 100-card test set from Eric's own cards, all six languages. |
| PT/EN detection fails | If the test set shows misses, leave the chip unanswered on Latin-script cards. Never fall back to a sticky default. |
| TCGdex image outage (recorded 2026-10-01) | Device image cache; a name-and-number placeholder when an uncached image fails. |
| TCGdex API down or changed | Cached catalog keeps browsing working; new scans queue for matching. Rate limits and image terms are unchecked (section 13). |
| Data loss | One row per card, CSV export from day one, a monthly export prompt. Supabase free tier pauses after 7 days idle. *Assumption:* a pause keeps data. Confirm. |
| Family adoption | Ship family features only after Eric has switched. Onboarding is one invite and one scan. Ask them what they want. |

**Hosting lean, product side only.** A PWA on GitHub Pages with Supabase. A few phones with an unknown iOS and Android mix get one codebase and one link, and fixes reach the family without store review. *Assumption:* native iOS needs a paid Apple developer account and makes family installs awkward. The open risk is iOS: *assumption,* camera access and storage eviction in an installed PWA behave differently on iOS Safari. The weekend-zero spike tests exactly that. If iOS fails it, that is the case for native. The final call stays technical.

## 8. Open Questions for Eric

| Question | Default if unanswered |
| --- | --- |
| One row per physical card instead of a quantity column? | Yes. |
| Which phones do the invited users have? | Build the PWA; spike on each one. |
| Trade extras per card, or per card, language, and variant? | Per card, language, and variant. |
| Scanner proposes a variant, or always asks? | Propose the base print; always show the chip. |
| Record condition? | Optional, blank on import. |
| Does Star hold cards the IR/SIR rule misses? `Todas` has only 13 IR/SIR rows. | Use the rule; diff once against an exported Star file. |
| CSV with semicolons and decimal commas, as monprice writes? | Yes. *Assumption:* Brazilian Excel expects it. |
| Any collection price total? | No. Per-card prices only, labeled by market. |
