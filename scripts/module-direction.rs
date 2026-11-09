#![feature(rustc_private)]
#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

// Built only for CI/development with the pinned toolchain's rustc-dev component.
// HIR retains resolved intermediate modules even when the final item is a re-export.
extern crate rustc_driver;
extern crate rustc_hir;
extern crate rustc_interface;
extern crate rustc_middle;
extern crate rustc_span;

use rustc_hir::{
    Expr, ExprKind, HirId, Item, ItemKind, Node, Path, UseKind, UsePath,
    def::{DefKind, Res},
    intravisit,
};
use rustc_middle::{
    hir::nested_filter,
    metadata::ModChild,
    ty::{self, TyCtxt},
};
use rustc_span::{
    Span,
    def_id::{CRATE_DEF_ID, CRATE_DEF_INDEX, DefId, LOCAL_CRATE, LocalDefId},
    hygiene::{ExpnKind, LocalExpnId},
};
use std::{collections::HashSet, process::ExitCode};

const MODULES: [&str; 4] = ["auth", "channels", "messages", "realtime"];

struct Check;

impl rustc_driver::Callbacks for Check {
    fn after_analysis<'tcx>(
        &mut self,
        _: &rustc_interface::interface::Compiler,
        tcx: TyCtxt<'tcx>,
    ) -> rustc_driver::Compilation {
        let mut visitor = Direction {
            tcx,
            modules: vec![(tcx.hir_root_module().spans.inner_span, CRATE_DEF_ID)],
            reported: HashSet::new(),
            imports: Vec::new(),
            aliases: HashSet::new(),
        };
        tcx.hir_walk_toplevel_module(&mut visitor);
        visitor.macros();
        rustc_driver::Compilation::Continue
    }
}

struct Direction<'tcx> {
    tcx: TyCtxt<'tcx>,
    modules: Vec<(Span, LocalDefId)>,
    reported: HashSet<(Span, usize, usize)>,
    imports: Vec<(Span, String, DefId, bool)>,
    aliases: HashSet<(LocalDefId, LocalDefId)>,
}

impl<'tcx> Direction<'tcx> {
    fn rank(&self, mut id: DefId) -> Option<usize> {
        if !id.is_local() {
            return None;
        }
        while let Some(parent) = self.tcx.opt_parent(id) {
            if parent.is_crate_root() {
                if self.tcx.def_kind(id) != rustc_hir::def::DefKind::Mod {
                    return None;
                }
                return MODULES
                    .iter()
                    .position(|name| self.tcx.item_name(id).as_str() == *name);
            }
            id = parent;
        }
        None
    }

    fn reference(&mut self, owner: LocalDefId, res: Res, span: Span) {
        if let Res::Def(_, target) = res {
            self.edge(owner, target, span);
            // Type aliases keep their own DefId, unlike use re-exports. Follow
            // their HIR paths with the caller's owner, retaining intermediate
            // module references that would disappear from the expanded type.
            if self.tcx.def_kind(target) == DefKind::TyAlias
                && let Some(local) = target.as_local()
                && self.aliases.insert((owner, local))
                && let Node::Item(item) = self.tcx.hir_node_by_def_id(local)
            {
                intravisit::Visitor::visit_item(
                    &mut AliasPaths {
                        direction: self,
                        owner,
                        span,
                    },
                    item,
                );
            }
        }
    }

    fn edge(&mut self, owner: LocalDefId, target: DefId, span: Span) {
        if let (Some(from), Some(to)) = (self.rank(owner.to_def_id()), self.rank(target))
            && to > from
            && self.reported.insert((span, from, to))
        {
            self.tcx.dcx().span_err(
                span,
                format!(
                    "module direction: {} must not reference {} ({})",
                    MODULES[from],
                    MODULES[to],
                    self.tcx.def_path_str(target),
                ),
            );
        }
    }

    fn module_at(&self, span: Span) -> Option<LocalDefId> {
        self.modules
            .iter()
            .filter(|(module, _)| module.ctxt() == span.ctxt() && module.contains(span))
            .min_by_key(|(module, _)| module.hi() - module.lo())
            .map(|(_, id)| *id)
    }

    fn macros(&mut self) {
        // An empty expansion leaves no HIR nodes. Enumerate every completed local
        // expansion, not just contexts reachable from HIR spans. Reserving a final
        // ID gives the exclusive upper bound; that empty sentinel is never read.
        let end = LocalExpnId::fresh_empty().as_u32();
        for index in 1..end {
            let data = LocalExpnId::from_u32(index).expn_data();
            let Some(target) = data.macro_def_id else {
                continue;
            };
            let mut context = data.clone();
            let owner = loop {
                if context.is_root() {
                    break None;
                }
                if let Some(owner) = self
                    .module_at(context.call_site)
                    .or_else(|| self.module_at(context.call_site.source_callsite()))
                {
                    break Some(owner);
                }
                // include!() can introduce a file whose spans are outside the
                // enclosing module. Its parent expansion retains the call site.
                context = context.parent.expn_data();
            };
            let Some(owner) = owner else {
                self.tcx.dcx().span_err(
                    data.call_site,
                    "module direction: cannot locate macro invocation module",
                );
                continue;
            };
            self.edge(owner, target, data.call_site);
            if let ExpnKind::Macro(_, name) = data.kind {
                self.macro_path(owner, name.as_str(), data.call_site);
            }
        }
    }

    fn macro_path(&mut self, owner: LocalDefId, path: &str, span: Span) {
        // Expansion data retains the written macro path, while macro_def_id gives
        // the final resolution. Also check module prefixes: a higher module may
        // re-export a macro defined in an otherwise permitted lower module.
        let mut module = owner.to_def_id();
        let mut first = true;
        let absolute = path.starts_with("::");
        let mut segments = path.split("::").peekable();
        while let Some(segment) = segments.next() {
            match segment {
                "crate" => module = CRATE_DEF_ID.to_def_id(),
                "$crate" => {
                    module = span
                        .ctxt()
                        .outer_expn_data()
                        .macro_def_id
                        .map(|id| DefId {
                            krate: id.krate,
                            index: CRATE_DEF_INDEX,
                        })
                        .unwrap_or(CRATE_DEF_ID.to_def_id());
                }
                "self" => (),
                "super" => {
                    module = self.tcx.opt_parent(module).unwrap_or(module);
                }
                "" => {
                    module = CRATE_DEF_ID.to_def_id();
                    continue;
                }
                name => {
                    if segments.peek().is_none() {
                        return;
                    }
                    if first
                        && !absolute
                        && let Some((_, _, target, _)) = self
                            .imports
                            .iter()
                            .filter(|(scope, alias, _, _)| {
                                alias == name && scope.ctxt() == span.ctxt() && scope.contains(span)
                            })
                            .min_by_key(|(scope, _, _, glob)| (scope.hi() - scope.lo(), *glob))
                    {
                        module = *target;
                        self.edge(owner, module, span);
                        first = false;
                        continue;
                    }
                    let mut scope = module;
                    let child = loop {
                        let found = self
                            .children(scope)
                            .iter()
                            .find(|child| {
                                child.ident.name.as_str() == name
                                    && matches!(
                                        child.res,
                                        Res::Def(rustc_hir::def::DefKind::Mod, _)
                                    )
                            })
                            .map(|child| child.res);
                        if found.is_some() || !first {
                            break found;
                        }
                        let Some(parent) = self.tcx.opt_parent(scope) else {
                            break None;
                        };
                        scope = parent;
                    };
                    let Some(Res::Def(_, id)) = child else {
                        if first
                            && (self.tcx.sess.opts.externs.get(name).is_some()
                                || matches!(name, "std" | "core" | "alloc" | "proc_macro"))
                        {
                            return;
                        }
                        self.tcx.dcx().span_err(
                            span,
                            format!("module direction: cannot resolve macro module prefix {name}"),
                        );
                        return;
                    };
                    self.edge(owner, id, span);
                    module = id;
                }
            }
            first = false;
        }
    }

    fn children(&self, module: DefId) -> &[ModChild] {
        if let Some(local) = module.as_local() {
            self.tcx.module_children_local(local)
        } else {
            self.tcx.module_children(module)
        }
    }

    fn import_scope(&self, item: &Item<'_>) -> Span {
        self.tcx
            .hir_parent_iter(item.hir_id())
            .find_map(|(_, node)| match node {
                Node::Block(block) => Some(block.span),
                Node::Item(Item {
                    kind: ItemKind::Mod(_, module),
                    ..
                }) => Some(module.spans.inner_span),
                _ => None,
            })
            .unwrap_or(self.tcx.hir_root_module().spans.inner_span)
    }
}

struct AliasPaths<'a, 'tcx> {
    direction: &'a mut Direction<'tcx>,
    owner: LocalDefId,
    span: Span,
}

impl<'tcx> intravisit::Visitor<'tcx> for AliasPaths<'_, 'tcx> {
    fn visit_path(&mut self, path: &Path<'tcx>, _: HirId) {
        self.direction.reference(self.owner, path.res, self.span);
        for segment in path.segments {
            self.direction.reference(self.owner, segment.res, self.span);
        }
        intravisit::walk_path(self, path);
    }
}

impl<'tcx> intravisit::Visitor<'tcx> for Direction<'tcx> {
    type NestedFilter = nested_filter::All;

    fn maybe_tcx(&mut self) -> TyCtxt<'tcx> {
        self.tcx
    }

    fn visit_item(&mut self, item: &'tcx Item<'tcx>) {
        if let ItemKind::Mod(_, module) = &item.kind {
            self.modules
                .push((module.spans.inner_span, item.owner_id.def_id));
        }
        if let ItemKind::Use(path, kind) = &item.kind {
            let scope = self.import_scope(item);
            if let Some(Res::Def(DefKind::Mod, target)) = path.res.type_ns {
                match kind {
                    UseKind::Single(ident) => {
                        self.imports
                            .push((scope, ident.name.to_string(), target, false))
                    }
                    UseKind::Glob => {
                        let children = if let Some(local) = target.as_local() {
                            self.tcx.module_children_local(local)
                        } else {
                            self.tcx.module_children(target)
                        };
                        for child in children {
                            if let Res::Def(DefKind::Mod, target) = child.res {
                                self.imports.push((
                                    scope,
                                    child.ident.name.to_string(),
                                    target,
                                    true,
                                ));
                            }
                        }
                    }
                    UseKind::ListStem => (),
                }
            }
        }
        if let ItemKind::ExternCrate(original, ident) = &item.kind
            && let Some(krate) = self
                .tcx
                .extern_mod_stmt_cnum(item.owner_id.def_id)
                .or_else(|| {
                    original
                        .is_some_and(|name| name.as_str() == "self")
                        .then_some(LOCAL_CRATE)
                })
        {
            self.imports.push((
                self.import_scope(item),
                ident.name.to_string(),
                DefId {
                    krate,
                    index: CRATE_DEF_INDEX,
                },
                false,
            ));
        }
        intravisit::walk_item(self, item);
    }

    fn visit_path(&mut self, path: &Path<'tcx>, id: HirId) {
        let owner = id.owner.def_id;
        self.reference(owner, path.res, path.span);
        for segment in path.segments {
            self.reference(owner, segment.res, segment.ident.span);
        }
        intravisit::walk_path(self, path);
    }

    fn visit_use(&mut self, path: &'tcx UsePath<'tcx>, id: HirId) {
        for res in path.res.iter().flatten() {
            self.reference(id.owner.def_id, *res, path.span);
        }
        for segment in path.segments {
            self.reference(id.owner.def_id, segment.res, segment.ident.span);
        }
        intravisit::walk_use(self, path, id);
    }

    fn visit_expr(&mut self, expression: &'tcx Expr<'tcx>) {
        let owner = expression.hir_id.owner.def_id;
        let typeck = self.tcx.typeck(owner);
        // Field access has no type-dependent DefId. Use rustc's adjusted
        // receiver and field index, including built-in/custom autoderef.
        if let ExprKind::Field(base, _) = expression.kind
            && let ty::Adt(definition, _) = typeck.expr_ty_adjusted(base).kind()
        {
            let index = typeck.field_index(expression.hir_id);
            self.edge(
                owner,
                definition.non_enum_variant().fields[index].did,
                expression.span,
            );
        }
        // Associated functions and inferred method/operator calls can resolve to
        // an impl in a higher module even when the receiver type is lower-level.
        if let Some(target) = typeck.type_dependent_def_id(expression.hir_id) {
            self.edge(owner, target, expression.span);
        }
        intravisit::walk_expr(self, expression);
    }
}

fn main() -> ExitCode {
    // RUSTC_WORKSPACE_WRAPPER receives the real rustc executable as argv[1].
    let mut args: Vec<_> = std::env::args().collect();
    if args.get(1).is_some_and(|arg| !arg.starts_with('-')) {
        args.remove(0);
    }
    rustc_driver::catch_with_exit_code(|| rustc_driver::run_compiler(&args, &mut Check))
}
