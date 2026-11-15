CREATE INDEX search_body ON messages USING pgroonga (normalized_body)
WITH (normalizers='', tokenizer='TokenNgram("unify_alphabet", false, "unify_symbol", false, "unify_digit", false)');
