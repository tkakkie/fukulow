#![cfg(test)]

use std::{fs, path::Path};
use syn::{
    Expr, ExprCall, ExprField, ExprStruct, FnArg, Ident, ItemFn, Member, Pat, Type, visit::Visit,
};

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
struct AppPoolWiring {
    violations: Vec<&'static str>,
    admin_parameters: Vec<Ident>,
}

impl AppPoolWiring {
    fn check_pool(&mut self, location: &'static str, pool: &Expr) {
        let mut admin = AdminPoolReference::default();
        admin.visit_expr(pool);
        if admin.0 || self.is_admin_parameter(pool) {
            self.violations.push(location);
        }
    }

    fn is_admin_parameter(&self, pool: &Expr) -> bool {
        match pool {
            Expr::Path(path) => path
                .path
                .get_ident()
                .is_some_and(|name| self.admin_parameters.contains(name)),
            Expr::Reference(reference) => self.is_admin_parameter(&reference.expr),
            Expr::Paren(paren) => self.is_admin_parameter(&paren.expr),
            Expr::Group(group) => self.is_admin_parameter(&group.expr),
            Expr::MethodCall(call) if call.method == "clone" && call.args.is_empty() => {
                self.is_admin_parameter(&call.receiver)
            }
            _ => false,
        }
    }
}

impl<'ast> Visit<'ast> for AppPoolWiring {
    fn visit_item_fn(&mut self, function: &'ast ItemFn) {
        let outer_parameters = std::mem::take(&mut self.admin_parameters);
        if function.attrs.iter().any(|attr| {
            let mut segments = attr.path().segments.iter();
            matches!(
                (segments.next(), segments.next(), segments.next()),
                (Some(krate), Some(test), None) if krate.ident == "fukulow_test" && test.ident == "test"
            )
        }) {
            for input in &function.sig.inputs {
                if let FnArg::Typed(parameter) = input
                    && let Pat::Ident(binding) = parameter.pat.as_ref()
                    && let Type::Path(ty) = parameter.ty.as_ref()
                    && ty.path.segments.last().is_some_and(|segment| segment.ident == "PgPool")
                {
                    self.admin_parameters.push(binding.ident.clone());
                }
            }
        }
        syn::visit::visit_item_fn(self, function);
        self.admin_parameters = outer_parameters;
    }

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
                wiring.violations.is_empty(),
                "{}: use the restricted app pool in {}",
                path.display(),
                wiring.violations.join(", ")
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
        wiring.violations,
        [
            "router",
            "router_with_cookie_security",
            "AppState.pool",
            "app_state"
        ]
    );
}

#[test]
fn app_pool_wiring_check_detects_admin_test_parameters() {
    let syntax = syn::parse_quote! {
        #[fukulow_test::test]
        async fn admin_parameter(admin: PgPool) {
            seed(&admin);
            router(&admin);
            AppState { pool: admin.clone(), ..state };
        }

        #[::fukulow_test::test(migrations = false)]
        async fn pool_parameter(pool: sqlx::PgPool) {
            router(&pool);
            router_with_cookie_security(&(pool.clone()), false);
        }

        #[fukulow_test::test]
        async fn arbitrary_parameter(database: PgPool) {
            app_state(&database, true);
        }

        fn restricted_pool_helper(pool: PgPool) {
            router(&pool);
        }
    };
    let mut wiring = AppPoolWiring::default();
    wiring.visit_file(&syntax);
    assert_eq!(
        wiring.violations,
        [
            "router",
            "AppState.pool",
            "router",
            "router_with_cookie_security",
            "app_state"
        ]
    );
}
