## Translation contribution

**Language:** <!-- e.g. Turkish (tr) -->
**Locale file:** <!-- e.g. locales/tr.json -->
**New language or update to existing?** <!-- New / Update -->

<!-- If this is an update, briefly describe what was changed and why. -->

## Checklist

- [ ] I have targeted the `dev` branch, not `main`
- [ ] My locale file is named correctly: `locales/<code>.json` using a lowercase BCP 47 tag (e.g. `tr`, `pt-br`, `zh-tw`)
- [ ] I translated all values from `locales/en.json` - no keys are missing or renamed
- [ ] I did not change any key names - only the values on the right-hand side of each entry
- [ ] I validated the JSON is well-formed: `node -e "JSON.parse(require('fs').readFileSync('locales/<code>.json', 'utf8'))"`
- [ ] I kept `{{placeholder}}` variables exactly as they appear in the English strings (same name, same braces)
- [ ] I tested my translation by setting `userLocale: "<code>"` in `config.js` and running the bridge

## Notes

<!-- Optional. Anything the reviewer should know - dialect choices, strings you were unsure about,
     regional variants, etc. -->
