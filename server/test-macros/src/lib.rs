use proc_macro::TokenStream;
use quote::quote;
use syn::{ItemFn, parse_macro_input, parse_quote};

/// Keep SQLx's database/fixture handling, but finish app-pool cleanup first.
#[proc_macro_attribute]
pub fn test(args: TokenStream, item: TokenStream) -> TokenStream {
    let mut function = parse_macro_input!(item as ItemFn);
    let body = function.block;
    function.block = parse_quote!({ crate::test_support::run(async move #body).await });
    let args = proc_macro2::TokenStream::from(args);
    quote!(#[::sqlx::test(#args)] #function).into()
}
