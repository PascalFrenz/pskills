package edd.pmd;

import net.sourceforge.pmd.lang.document.FileLocation;
import net.sourceforge.pmd.lang.java.ast.ASTCompilationUnit;
import net.sourceforge.pmd.lang.java.ast.JavaComment;
import net.sourceforge.pmd.lang.java.rule.AbstractJavaRulechainRule;
import net.sourceforge.pmd.reporting.RuleContext;

public class InlineCommentRule extends AbstractJavaRulechainRule {

    public InlineCommentRule() {
        super(ASTCompilationUnit.class);
    }

    @Override
    public Object visit(ASTCompilationUnit node, Object data) {
        RuleContext context = (RuleContext) data;
        for (JavaComment comment : node.getComments()) {
            if (!comment.hasJavadocContent()) {
                FileLocation location = comment.getReportLocation();
                context.addViolationWithPosition(node, location.getStartLine(), location.getEndLine(), getMessage());
            }
        }
        return null;
    }
}
