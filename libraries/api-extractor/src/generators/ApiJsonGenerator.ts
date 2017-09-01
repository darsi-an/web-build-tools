// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as os  from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import { JsonFile, JsonSchema, IJsonSchemaErrorInfo } from '@microsoft/node-core-library';

import Extractor from '../Extractor';
import AstStructuredType from '../ast/AstStructuredType';
import AstEnum from '../ast/AstEnum';
import AstEnumValue from '../ast/AstEnumValue';
import AstFunction from '../ast/AstFunction';
import AstItem, { AstItemKind } from '../ast/AstItem';
import AstItemVisitor from './AstItemVisitor';
import AstPackage from '../ast/AstPackage';
import AstParameter from '../ast/AstParameter';
import AstProperty from '../ast/AstProperty';
import AstMember, { AccessModifier } from '../ast/AstMember';
import AstNamespace from '../ast/AstNamespace';
import AstModuleVariable from '../ast/AstModuleVariable';
import AstMethod from '../ast/AstMethod';
import { ReleaseTag } from '../aedoc/ApiDocumentation';
import { IReturn, IParam } from '../jsonItem/JsonItem';
import ApiJsonFile from '../jsonItem/ApiJsonFile';

/**
 * For a library such as "example-package", ApiFileGenerator generates the "example-package.api.ts"
 * report which is used to detect API changes.  The output is pseudocode whose syntax is similar
 * but not identical to a "*.d.ts" typings file.  The output file is designed to be committed to
 * Git with a branch policy that will trigger an API review workflow whenever the file contents
 * have changed.  For example, the API file indicates *whether* a class has been documented,
 * but it does not include the documentation text (since minor text changes should not require
 * an API review).
 *
 * @public
 */
export default class ApiJsonGenerator extends AstItemVisitor {
  private static _methodCounter: number = 0;
  private static _MEMBERS_KEY: string = 'members';
  private static _EXPORTS_KEY: string = 'exports';
  private static _jsonSchema: JsonSchema | undefined = undefined;

  /**
   * The JSON schema for the *.api.json file format.
   */
  public static get jsonSchema(): JsonSchema {
    if (!ApiJsonGenerator._jsonSchema) {
      ApiJsonGenerator._jsonSchema = JsonSchema.fromFile(path.join(__dirname, '../jsonItem/api-json.schema.json'));
    }

    return ApiJsonGenerator._jsonSchema;
  }

  protected jsonOutput: Object = {};

  public writeJsonFile(reportFilename: string, extractor: Extractor): void {
    this.visit(extractor.package, this.jsonOutput);

    // Write the output before validating the schema, so we can debug it
    JsonFile.save(this.jsonOutput, reportFilename);

    // Validate that the output conforms to our JSON schema
    ApiJsonGenerator.jsonSchema.validateObjectWithCallback(this.jsonOutput, (errorInfo: IJsonSchemaErrorInfo) => {
      const errorMessage: string = path.basename(reportFilename)
        + ` does not conform to the expected schema -- please report this API Extractor bug:`
        + os.EOL + errorInfo.details;

      console.log(os.EOL + 'ERROR: ' + errorMessage + os.EOL + os.EOL);
      throw new Error(errorMessage);
    });
  }

  // @override
  protected visit(astItem: AstItem, refObject?: Object): void {
    switch (astItem.documentation.releaseTag) {
      case ReleaseTag.None:
      case ReleaseTag.Beta:
      case ReleaseTag.Public:
        break;
      default:
        return; // skip @alpha and @internal definitions
    }

    super.visit(astItem, refObject);
  }

  protected visitAstStructuredType(apiStructuredType: AstStructuredType, refObject?: Object): void {
    if (!apiStructuredType.supportedName) {
      return;
    }

    const kind: string =
      apiStructuredType.kind === AstItemKind.Class ? ApiJsonFile.convertKindToJson(AstItemKind.Class) :
      apiStructuredType.kind === AstItemKind.Interface ?
        ApiJsonFile.convertKindToJson(AstItemKind.Interface) : '';

    const structureNode: Object = {
      kind: kind,
      extends: apiStructuredType.extends || '',
      implements: apiStructuredType.implements || '',
      typeParameters: apiStructuredType.typeParameters || [],
      deprecatedMessage: apiStructuredType.documentation.deprecatedMessage || [],
      summary: apiStructuredType.documentation.summary || [],
      remarks: apiStructuredType.documentation.remarks || [],
      isBeta: apiStructuredType.documentation.releaseTag === ReleaseTag.Beta
    };
    refObject[apiStructuredType.name] = structureNode;

    ApiJsonGenerator._methodCounter = 0;

    const members: AstItem[] = apiStructuredType.getSortedMemberItems();

    if (members && members.length) {
      const membersNode: Object = {};
      structureNode[ApiJsonGenerator._MEMBERS_KEY] = membersNode;

      for (const astItem of members) {
        this.visit(astItem, membersNode);
      }
    }
  }

  protected visitAstEnum(apiEnum: AstEnum, refObject?: Object): void {
    if (!apiEnum.supportedName) {
      return;
    }

    const valuesNode: Object = {};
    const enumNode: Object = {
      kind: ApiJsonFile.convertKindToJson(apiEnum.kind),
      values: valuesNode,
      deprecatedMessage: apiEnum.documentation.deprecatedMessage || [],
      summary: apiEnum.documentation.summary || [],
      remarks: apiEnum.documentation.remarks || [],
      isBeta: apiEnum.documentation.releaseTag === ReleaseTag.Beta
    };
    refObject[apiEnum.name] = enumNode;

    for (const astItem of apiEnum.getSortedMemberItems()) {
      this.visit(astItem, valuesNode);
    }
  }

  protected visitAstEnumValue(apiEnumValue: AstEnumValue, refObject?: Object): void {
    if (!apiEnumValue.supportedName) {
      return;
    }

    const declaration: ts.Declaration = apiEnumValue.getDeclaration();
    const firstToken: ts.Node = declaration ? declaration.getFirstToken() : undefined;
    const lastToken: ts.Node = declaration ? declaration.getLastToken() : undefined;

    const value: string = lastToken && lastToken !== firstToken ? lastToken.getText() : '';

    refObject[apiEnumValue.name] = {
      kind: ApiJsonFile.convertKindToJson(apiEnumValue.kind),
      value: value,
      deprecatedMessage: apiEnumValue.documentation.deprecatedMessage || [],
      summary: apiEnumValue.documentation.summary || [],
      remarks: apiEnumValue.documentation.remarks || [],
      isBeta: apiEnumValue.documentation.releaseTag === ReleaseTag.Beta
    };
  }

  protected visitAstFunction(apiFunction: AstFunction, refObject?: Object): void {
    if (!apiFunction.supportedName) {
      return;
    }

    for (const param of apiFunction.params) {
      this.visitApiParam(param, apiFunction.documentation.parameters[param.name]);
    }
    const returnValueNode: IReturn = {
      type: apiFunction.returnType,
      description: apiFunction.documentation.returnsMessage
    };

    const newNode: Object = {
      kind: ApiJsonFile.convertKindToJson(apiFunction.kind),
      returnValue: returnValueNode,
      parameters: apiFunction.documentation.parameters,
      deprecatedMessage: apiFunction.documentation.deprecatedMessage || [],
      summary: apiFunction.documentation.summary || [],
      remarks: apiFunction.documentation.remarks || [],
      isBeta: apiFunction.documentation.releaseTag === ReleaseTag.Beta
    };

    refObject[apiFunction.name] = newNode;
  }

  protected visitAstPackage(apiPackage: AstPackage, refObject?: Object): void {
    /* tslint:disable:no-string-literal */
    refObject['kind'] = ApiJsonFile.convertKindToJson(apiPackage.kind);
    refObject['summary'] = apiPackage.documentation.summary;
    refObject['remarks'] = apiPackage.documentation.remarks;
    /* tslint:enable:no-string-literal */

    const membersNode: Object = {};
    refObject[ApiJsonGenerator._EXPORTS_KEY] = membersNode;

    for (const astItem of apiPackage.getSortedMemberItems()) {
      this.visit(astItem, membersNode);
    }
  }

  protected visitAstNamespace(apiNamespace: AstNamespace, refObject?: Object): void {
    if (!apiNamespace.supportedName) {
      return;
    }

    const membersNode: Object = {};
    for (const astItem of apiNamespace.getSortedMemberItems()) {
      this.visit(astItem, membersNode);
    }

    const newNode: Object = {
      kind: ApiJsonFile.convertKindToJson(apiNamespace.kind),
      deprecatedMessage: apiNamespace.documentation.deprecatedMessage || [],
      summary: apiNamespace.documentation.summary || [],
      remarks: apiNamespace.documentation.remarks || [],
      isBeta: apiNamespace.documentation.releaseTag === ReleaseTag.Beta,
      exports: membersNode
    };

    refObject[apiNamespace.name] = newNode;
  }

  protected visitAstMember(apiMember: AstMember, refObject?: Object): void {
    if (!apiMember.supportedName) {
      return;
    }

    refObject[apiMember.name] = 'apiMember-' + apiMember.getDeclaration().kind;
  }

  protected visitAstProperty(apiProperty: AstProperty, refObject?: Object): void {
    if (!apiProperty.supportedName) {
      return;
    }

    if (apiProperty.getDeclaration().kind === ts.SyntaxKind.SetAccessor) {
      return;
    }

    const newNode: Object = {
      kind: ApiJsonFile.convertKindToJson(apiProperty.kind),
      isOptional: !!apiProperty.isOptional,
      isReadOnly: !!apiProperty.isReadOnly,
      isStatic: !!apiProperty.isStatic,
      type: apiProperty.type,
      deprecatedMessage: apiProperty.documentation.deprecatedMessage || [],
      summary: apiProperty.documentation.summary || [],
      remarks: apiProperty.documentation.remarks || [],
      isBeta: apiProperty.documentation.releaseTag === ReleaseTag.Beta
    };

    refObject[apiProperty.name] = newNode;
  }

  protected visitAstModuleVariable(apiModuleVariable: AstModuleVariable, refObject?: Object): void {
    const newNode: Object = {
      kind: ApiJsonFile.convertKindToJson(apiModuleVariable.kind),
      type: apiModuleVariable.type,
      value: apiModuleVariable.value,
      deprecatedMessage: apiModuleVariable.documentation.deprecatedMessage || [],
      summary: apiModuleVariable.documentation.summary || [],
      remarks: apiModuleVariable.documentation.remarks || [],
      isBeta: apiModuleVariable.documentation.releaseTag === ReleaseTag.Beta
    };

    refObject[apiModuleVariable.name] = newNode;
  }

  protected visitAstMethod(apiMethod: AstMethod, refObject?: Object): void {
    if (!apiMethod.supportedName) {
      return;
    }

    for (const param of apiMethod.params) {
      this.visitApiParam(param, apiMethod.documentation.parameters[param.name]);
    }

    let newNode: Object;
    if (apiMethod.name === '__constructor') {
      newNode = {
        kind: ApiJsonFile.convertKindToJson(AstItemKind.Constructor),
        signature: apiMethod.getDeclarationLine(),
        parameters: apiMethod.documentation.parameters,
        deprecatedMessage: apiMethod.documentation.deprecatedMessage || [],
        summary: apiMethod.documentation.summary || [],
        remarks: apiMethod.documentation.remarks || []
      };
    } else {
      const returnValueNode: IReturn = {
        type: apiMethod.returnType,
        description: apiMethod.documentation.returnsMessage
      };

      newNode = {
        kind: ApiJsonFile.convertKindToJson(apiMethod.kind),
        signature: apiMethod.getDeclarationLine(),
        accessModifier: apiMethod.accessModifier ? AccessModifier[apiMethod.accessModifier].toLowerCase() : '',
        isOptional: !!apiMethod.isOptional,
        isStatic: !!apiMethod.isStatic,
        returnValue: returnValueNode,
        parameters: apiMethod.documentation.parameters,
        deprecatedMessage: apiMethod.documentation.deprecatedMessage || [],
        summary: apiMethod.documentation.summary || [],
        remarks: apiMethod.documentation.remarks || [],
        isBeta: apiMethod.documentation.releaseTag === ReleaseTag.Beta
      };
    }

    refObject[apiMethod.name] = newNode;
  }

  protected visitApiParam(apiParam: AstParameter, refObject?: Object): void {
    if (!apiParam.supportedName) {
      return;
    }

    if (refObject) {
      (refObject as IParam).isOptional = apiParam.isOptional;
      (refObject as IParam).isSpread = apiParam.isSpread;
      (refObject as IParam).type = apiParam.type;
    }
  }
}
