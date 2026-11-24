#![cfg(test)]

use std::{fs, path::Path};
use syn::{Expr, ExprCall, ExprField, ExprStruct, Member, visit::Visit};

#[derive(Default)]
struct AdminPoolReference(bool);

impl<'ast> Visit<'ast> for AdminPoolReference {
    fn visit_expr_field(&mut self, field: &'ast ExprField) {
        if matches!(&field.member, Member::Named(name) if name == "admin") {
            self.0 = true;
        }
        syn::visit::visit_expr_field(self, field);
    }
}

#[derive(Default)]
struct AppPoolWiring(Vec<&'static str>);

impl AppPoolWiring {
    fn check_pool(&mut self, location: &'static str, pool: &Expr) {
        let mut admin = AdminPoolReference::default();
        admin.visit_expr(pool);
        if admin.0 {
            self.0.push(location);
        }
    }
}

impl<'ast> Visit<'ast> for AppPoolWiring {
    fn visit_expr_struct(&mut self, expr: &'ast ExprStruct) {
        if expr
            .path
            .segments
            .last()
            .is_some_and(|segment| segment.ident == "AppState")
        {
            for field in &expr.fields {
                if matches!(&field.member, Member::Named(name) if name == "pool") {
                    self.check_pool("AppState.pool", &field.expr);
                }
            }
        }
        syn::visit::visit_expr_struct(self, expr);
    }

    fn visit_expr_call(&mut self, expr: &'ast ExprCall) {
        if let Expr::Path(function) = expr.func.as_ref()
            && let Some(segment) = function.path.segments.last()
            && let Some(pool) = expr.args.first()
        {
            for name in ["router", "router_with_cookie_security", "app_state"] {
                if segment.ident == name {
                    self.check_pool(name, pool);
                }
            }
        }
        syn::visit::visit_expr_call(self, expr);
    }
}

fn check_test_sources(directory: &Path) {
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            check_test_sources(&path);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            let source = fs::read_to_string(&path).unwrap();
            let syntax = syn::parse_file(&source)
                .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
            let mut wiring = AppPoolWiring::default();
            wiring.visit_file(&syntax);
            assert!(
                wiring.0.is_empty(),
                "{}: use the restricted app pool in {}",
                path.display(),
                wiring.0.join(", ")
            );
        }
    }
}

#[test]
fn integration_tests_keep_direct_admin_pool_references_out_of_app_wiring() {
    check_test_sources(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests"));
}

#[test]
fn app_pool_wiring_check_detects_admin_pool_misuse() {
    let syntax = syn::parse_quote! {
        fn example(pools: TestPools) {
            seed(&pools.admin);
            router(&pools.app);
            router(
                &pools.admin,
            );
            router_with_cookie_security(&pools.admin, false);
            fukulow_server::AppState {
                pool: pools.admin.clone(),
                ..app_state(&pools.admin, true)
            };
        }
    };
    let mut wiring = AppPoolWiring::default();
    wiring.visit_file(&syntax);
    assert_eq!(
        wiring.0,
        [
            "router",
            "router_with_cookie_security",
            "AppState.pool",
            "app_state"
        ]
    );
}
