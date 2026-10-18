/**
 * Text processing utilities for template rendering and token estimation.
 */
export const TextProcessor = {
  /**
   * Safely renders template strings with variable substitution
   * @param {string} template - Template string containing ${key} placeholders
   * @param {Object} data - Data object for variable substitution
   * @returns {string} Rendered string
   * @example renderTemplate('Hello ${user.name}', {user: {name: 'John'}}) => 'Hello John'
   */
  renderTemplate(template, data) {
    if (typeof template !== 'string' || !data) return template;
    return template.replace(/\${(.*?)}/g, (_, key) => {
      return key.split('.').reduce((obj, k) => (obj || {})[k.trim()], data) || '';
    });
  },

  /**
   * Estimates token count for mixed Chinese/English text
   * @param {string} text - Input text
   * @returns {number} Estimated token count
   */
  estimateTokens(text) {
    if (!text) return 0;
    
    const chinese = text.match(/[\u4e00-\u9fa5]/g) || [];
    const words = text.split(/[\s\n]+/).filter(w => w);
    const symbols = text.match(/[^\p{L}\s]/gu) || [];
    
    // Estimation based on GPT-4 encoding patterns
    const chineseTokens = chinese.length * 1.3; // ~2.5 tokens per character
    const wordTokens = words.length * 1.3;
    const symbolTokens = symbols.length * 0.7;
    
    // Add 10% safety margin
    return Math.ceil((chineseTokens + wordTokens + symbolTokens) * 1.1);
  }
};