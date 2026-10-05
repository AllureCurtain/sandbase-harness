// Initialize the Console i18n instance so components using useTranslation get
// real resources under vitest. Language is pinned to English for deterministic
// assertions; components under test can still switch it.
import i18n from '../../../apps/console/src/i18n';

void i18n.changeLanguage('en');
