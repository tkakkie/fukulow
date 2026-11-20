CREATE INDEX search_terms_exact ON public.search_terms
    USING pgroonga (scope_term public.pgroonga_text_term_search_ops_v2)
    WITH (normalizers = '', tokenizer = '');
